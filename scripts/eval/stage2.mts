/**
 * Вторая ступень над объединённым пулом первой (см. qx.mts):
 * пул = RRF(base, kw, hydeD, lex) топ-50 живого кода.
 *
 *   fused      — контроль: порядок первой ступени как есть
 *   ce         — cross-encoder по топ-50, RRF-слияние с порядком пула (вес 0.5)
 *   llm        — listwise-реранк топ-30 локальной LLM, слияние по рангам (вес свип)
 *   ce+llm     — CE-слияние, затем LLM по его топ-20
 *
 * Все LLM-выводы кэшируются: scratch/out/rr-cache.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { db, toVectorLiteral, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { Reranker } from '../src/rerank/client.js'
import { loadGolden } from '../src/eval/run.js'
import { loadConfig } from '../src/config.js'
import { compilePriors } from '../src/store/priors.js'
import type { SearchHit } from '../src/types.js'

const QX_MODEL = process.env.QX_MODEL ?? 'gemma3:latest'
const RR_MODEL = process.env.RR_MODEL ?? 'qwen3-vl:8b'
const POOL = 50
const LLM_HEAD = 30

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const cfg = loadConfig()
const priors = compilePriors(cfg)
const embedder = new Embedder()
const modelId = await embedder.model()
const reranker = new Reranker(undefined, 300_000)

const qxCache: Record<string, { keywords: string[]; code: string }> = JSON.parse(
  readFileSync('scratch/out/qx-cache.json', 'utf8'),
)
const RR_CACHE = 'scratch/out/rr-cache.json'
const rrCache: Record<string, number[]> = existsSync(RR_CACHE) ? JSON.parse(readFileSync(RR_CACHE, 'utf8')) : {}

interface Row {
  id: string
  path: string
  symbol: string | null
  kind: string
  parent_chain: string[]
  lang: string
  raw_text: string
  embed_text: string
}

const matchOf = (wanted: Set<string>) => (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
  wanted.has(r.path) ||
  (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
  (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

async function vecIds(v: number[], limit: number): Promise<string[]> {
  const { rows } = await db().query<{ id: string }>(
    `SELECT l.id::text
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
      ORDER BY c.embedding <=> $1::vector LIMIT $3`,
    [toVectorLiteral(v), modelId, limit],
  )
  return rows.map((r) => r.id)
}

async function lexIds(terms: string[], limit: number): Promise<string[]> {
  if (!terms.length) return []
  const { rows } = await db().query<{ id: string }>(
    `SELECT l.id::text
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id,
            code_query($2) q
      WHERE r.name = 'unitify' AND c.model_id = $3 AND l.path NOT LIKE '@deleted/%'
        AND q != ''::tsquery AND c.tsv @@ q
      ORDER BY ts_rank(c.tsv, q) DESC LIMIT $1`,
    [limit, terms.join(' '), modelId],
  )
  return rows.map((r) => r.id)
}

/** Первая строка `// doc:` из обогащённого заголовка. */
function docLine(embedText: string): string {
  const m = embedText.match(/^\/\/ doc: (.+)$/m)
  return m ? m[1]! : ''
}

function candidateCard(r: Row, i: number): string {
  const code = r.raw_text.split('\n').slice(0, 6).join('\n')
  const doc = docLine(r.embed_text)
  return `[${i}] ${r.path} :: ${r.symbol ?? r.kind}${doc ? `\n// ${doc}` : ''}\n${code}`
}

async function llmRank(q: string, cands: Row[]): Promise<number[]> {
  const key = createHash('sha256')
    .update(`${RR_MODEL}::${q}::${cands.map((c) => c.id).join(',')}`)
    .digest('hex')
  if (rrCache[key]) return rrCache[key]

  const prompt =
    `Вопрос разработчика о JS/TS-монорепе: «${q}»\n\n` +
    `Ниже ${cands.length} фрагментов-кандидатов. Определи, какие из них реализуют то, о чём спрашивают ` +
    `(не тесты и не документацию, если есть реализация). Верни JSON {"ranking": [индексы до 10 лучших, от лучшего к худшему]}.\n\n` +
    cands.map((c, i) => candidateCard(c, i)).join('\n\n')

  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: RR_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0, num_predict: 200, num_ctx: 16384 },
    }),
  })
  const data = (await res.json()) as { response: string; thinking?: string }
  // Рассуждающие модели (qwen3-vl) кладут вывод в thinking, response пуст.
  const raw = data.response || data.thinking || ''
  let ranking: number[] = []
  try {
    const parsed = JSON.parse(raw) as { ranking?: unknown }
    if (Array.isArray(parsed.ranking)) {
      ranking = parsed.ranking.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < cands.length)
      ranking = [...new Set(ranking)]
    }
  } catch {
    /* пустой ответ = реранка нет */
  }
  rrCache[key] = ranking
  writeFileSync(RR_CACHE, JSON.stringify(rrCache))
  return ranking
}

/** RRF-слияние порядка пула с частичным порядком судьи (незалистанные — без слагаемого). */
function fuseJudge(pool: Row[], judgeIdx: number[], w: number): Row[] {
  const jr = new Map<string, number>()
  judgeIdx.forEach((idx, i) => jr.set(pool[idx]!.id, i + 1))
  return pool
    .map((r, i) => ({
      r,
      s: 1 / (60 + i + 1) + (jr.has(r.id) ? w / (60 + jr.get(r.id)!) : 0),
    }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r)
}

const results: Record<string, (number | null)[]> = {}
const push = (name: string, rank: number | null) => (results[name] ??= []).push(rank)

for (const entry of golden) {
  const match = matchOf(new Set(entry.expect))
  const { keywords, code } = qxCache[`${QX_MODEL}::${entry.q}`] ?? { keywords: [], code: '' }

  const [vBase, vKw] = await embedder.embed([entry.q, `${entry.q}\n${keywords.join(' ')}`], 'query')
  const [vHydeD] = await embedder.embed([code || entry.q], 'document')

  const lists = [
    await vecIds(vBase!, 1000),
    await vecIds(vKw!, 1000),
    await vecIds(vHydeD!, 1000),
    await lexIds(keywords, 1000),
  ]
  const fusedScore = new Map<string, number>()
  for (const list of lists)
    list.forEach((id, i) => fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (60 + i + 1)))
  const poolIds = [...fusedScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, POOL).map(([id]) => id)

  const { rows } = await db().query<Row>(
    `SELECT l.id::text, l.path, l.symbol, l.kind, l.parent_chain, l.lang, c.raw_text, c.embed_text
       FROM chunk_locations l JOIN chunks c USING (content_hash)
      WHERE l.id = ANY($1::bigint[])`,
    [poolIds],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const pool = poolIds.map((id) => byId.get(id)!).filter(Boolean)

  const rankIn = (rs: Row[]) => {
    const i = rs.findIndex(match)
    return i < 0 ? null : i + 1
  }

  push('fused', rankIn(pool))

  // CE по топ-50 пула, слияние RRF вес 0.5, с priors
  const ce = await reranker.score(entry.q, pool.map((r) => r.embed_text))
  if (!ce) throw new Error('реранкер недоступен')
  const prior = (r: Row) => priors.apply({ path: r.path, symbol: r.symbol, kind: r.kind, lang: r.lang } as unknown as SearchHit)
  const byCe = [...pool.keys()].sort((a, b) => ce[b]! * prior(pool[b]!) - ce[a]! * prior(pool[a]!))
  const ceRank = new Map(byCe.map((pi, i) => [pool[pi]!.id, i + 1]))
  const ceFused = pool
    .map((r, i) => ({ r, s: 1 / (60 + i + 1) + 0.5 / (60 + ceRank.get(r.id)!) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r)
  push('ce', rankIn(ceFused))

  // LLM-судья по топ-30 пула
  const head = pool.slice(0, LLM_HEAD)
  const judged = await llmRank(entry.q, head)
  for (const w of [1, 2]) {
    const fusedJ = [...fuseJudge(head, judged, w), ...pool.slice(LLM_HEAD)]
    push(`llm w=${w}`, rankIn(fusedJ))
  }
  const replaced = [
    ...judged.map((i) => head[i]!),
    ...head.filter((_, i) => !judged.includes(i)),
    ...pool.slice(LLM_HEAD),
  ]
  push('llm replace', rankIn(replaced))

  // CE-слияние → LLM по его топ-20
  const head2 = ceFused.slice(0, 20)
  const judged2 = await llmRank(entry.q, head2)
  const fused2 = [...fuseJudge(head2, judged2, 2), ...ceFused.slice(20)]
  push('ce→llm w=2', rankIn(fused2))

  process.stderr.write('.')
}
process.stderr.write('\n')

const n = golden.length
console.log(`Первая ступень: RRF(base, kw, hydeD, lex) топ-${POOL}, генератор ${QX_MODEL}; судья ${RR_MODEL}\n`)
console.log('вариант          @1      @5     @10     MRR')
for (const [name, rs] of Object.entries(results)) {
  const at = (k: number) => rs.filter((r) => r !== null && r <= k).length / n
  const mrr = rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n
  console.log(
    `${name.padEnd(13)} ${(at(1) * 100).toFixed(1).padStart(5)}%  ${(at(5) * 100).toFixed(1).padStart(5)}%  ${(at(10) * 100).toFixed(1).padStart(5)}%   ${mrr.toFixed(3)}`,
  )
}
await closeDb()
