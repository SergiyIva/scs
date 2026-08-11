/**
 * Составной замер: объединённый пул (§3.2) → LLM-судья, читающий карточки
 * С ОПИСАНИЯМИ НАЗНАЧЕНИЯ (§3.5) вместо голого кода.
 * Отличие от stage2: в карточку кандидата добавлено описание; кэш-ключ v2.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { db, toVectorLiteral, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { loadGolden } from '../src/eval/run.js'

const QX_MODEL = process.env.QX_MODEL ?? 'gemma3:latest'
const RR_MODEL = process.env.RR_MODEL ?? 'qwen3-vl:8b'
const DESC_MODEL = process.env.DESC_MODEL ?? 'gemma3:latest'
const POOL = 50
const LLM_HEAD = 30

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()
const modelId = await embedder.model()

const qxCache: Record<string, { keywords: string[]; code: string }> = JSON.parse(
  readFileSync('scratch/out/qx-cache.json', 'utf8'),
)
const descCache: Record<string, string> = JSON.parse(readFileSync('scratch/out/desc-cache.json', 'utf8'))
const RR_CACHE = 'scratch/out/rr-cache.json'
const rrCache: Record<string, number[]> = existsSync(RR_CACHE) ? JSON.parse(readFileSync(RR_CACHE, 'utf8')) : {}

interface Row {
  id: string
  hash: string
  path: string
  symbol: string | null
  kind: string
  parent_chain: string[]
  lang: string
  raw_text: string
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

async function llmRank(q: string, cards: string[], idsKey: string): Promise<number[]> {
  const key = createHash('sha256').update(`v2desc::${RR_MODEL}::${q}::${idsKey}`).digest('hex')
  if (rrCache[key]) return rrCache[key]
  const prompt =
    `Вопрос разработчика о JS/TS-монорепе: «${q}»\n\n` +
    `Ниже ${cards.length} фрагментов-кандидатов, у каждого есть описание назначения. Определи, какие реализуют то, ` +
    `о чём спрашивают (не тесты и не документацию, если есть реализация). Верни JSON {"ranking": [индексы до 10 лучших, от лучшего к худшему]}.\n\n` +
    cards.join('\n\n')
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: RR_MODEL, prompt, stream: false, format: 'json',
      options: { temperature: 0, num_predict: 200, num_ctx: 16384 },
    }),
  })
  const data = (await res.json()) as { response: string; thinking?: string }
  const raw = data.response || data.thinking || ''
  let ranking: number[] = []
  try {
    const parsed = JSON.parse(raw) as { ranking?: unknown }
    if (Array.isArray(parsed.ranking)) {
      ranking = [...new Set(parsed.ranking.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < cards.length))]
    }
  } catch { /* нет реранка */ }
  rrCache[key] = ranking
  writeFileSync(RR_CACHE, JSON.stringify(rrCache))
  return ranking
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
    `SELECT l.id::text, encode(l.content_hash,'hex') AS hash, l.path, l.symbol, l.kind,
            l.parent_chain, l.lang, c.raw_text
       FROM chunk_locations l JOIN chunks c USING (content_hash)
      WHERE l.id = ANY($1::bigint[])`,
    [poolIds],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const pool = poolIds.map((id) => byId.get(id)!).filter(Boolean)

  push('fused', (() => { const i = pool.findIndex(match); return i < 0 ? null : i + 1 })())

  const head = pool.slice(0, LLM_HEAD)
  const cards = head.map((r, i) => {
    const desc = descCache[`${DESC_MODEL}::${r.hash}`] ?? ''
    const codeLines = r.raw_text.split('\n').slice(0, 5).join('\n')
    return `[${i}] ${r.path} :: ${r.symbol ?? r.kind}${desc ? `\nНазначение: ${desc.slice(0, 320)}` : ''}\n${codeLines}`
  })
  const judged = await llmRank(entry.q, cards, head.map((c) => c.id).join(','))
  for (const w of [2]) {
    const jr = new Map<string, number>()
    judged.forEach((idx, i) => jr.set(head[idx]!.id, i + 1))
    const fusedJ = [
      ...head
        .map((r, i) => ({ r, s: 1 / (60 + i + 1) + (jr.has(r.id) ? w / (60 + jr.get(r.id)!) : 0) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r),
      ...pool.slice(LLM_HEAD),
    ]
    push(`llm+desc w=${w}`, (() => { const i = fusedJ.findIndex(match); return i < 0 ? null : i + 1 })())
  }
  process.stderr.write('.')
}
process.stderr.write('\n')

const n = golden.length
console.log(`Судья ${RR_MODEL} читает описания (${DESC_MODEL}) поверх пула §3.2:\n`)
console.log('вариант          @1      @5     @10     MRR')
for (const [name, rs] of Object.entries(results)) {
  const at = (k: number) => rs.filter((r) => r !== null && r <= k).length / n
  const mrr = rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n
  console.log(
    `${name.padEnd(14)} ${(at(1) * 100).toFixed(1).padStart(5)}%  ${(at(5) * 100).toFixed(1).padStart(5)}%  ${(at(10) * 100).toFixed(1).padStart(5)}%   ${mrr.toFixed(3)}`,
  )
}
await closeDb()
