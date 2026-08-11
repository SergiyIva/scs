/**
 * Query-side трансформации: может ли LLM-переформулировка запроса поднять
 * ПЕРВУЮ ступень (полноту верхушки векторной выдачи), которую не достаёт
 * cross-encoder. Меряем ранг ожидаемого ответа (живой код, без @deleted)
 * для каждого варианта запроса.
 *
 *   base   — исходный запрос
 *   kw     — запрос + LLM-угаданные английские термины кода
 *   hydeQ  — гипотетический фрагмент кода, эмбеддинг с префиксом query
 *   hydeD  — он же с префиксом document (док-пространство)
 *   lex    — FTS по угаданным терминам (code_query), ранжирование ts_rank
 *   rrf    — слияние base+kw+hydeD+lex по рангам
 *   oracle — min-ранг по всем вариантам (потолок мульти-запроса)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { db, toVectorLiteral, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { loadGolden } from '../src/eval/run.js'

const MODEL = process.env.QX_MODEL ?? 'gemma3:latest'
const LIMIT = 1000
const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()
const modelId = await embedder.model()

const CACHE = 'scratch/out/qx-cache.json'
const cache: Record<string, { keywords: string[]; code: string }> = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, 'utf8'))
  : {}

async function gen(q: string): Promise<{ keywords: string[]; code: string }> {
  const key = `${MODEL}::${q}`
  if (cache[key]) return cache[key]
  const prompt =
    `Ты помогаешь искать код в JS/TS-монорепе платформы управляющей компании ` +
    `(биллинг, приём платежей, заявки жильцов, приборы учёта, организации, документооборот; ` +
    `backend Node/Keystone c GraphQL-схемами, frontend React).\n` +
    `Вопрос: «${q}»\n` +
    `Выведи JSON с полями: keywords — 10-14 английских терминов, которые вероятно встречаются ` +
    `в искомом фрагменте кода (имена функций/констант в camelCase или SCREAMING_SNAKE_CASE, доменные слова); ` +
    `code — гипотетический фрагмент JS 5-12 строк, как мог бы выглядеть ответ: реалистичные имена, ` +
    `короткий английский JSDoc о назначении.`
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.3, num_predict: 500 },
    }),
  })
  const data = (await res.json()) as { response: string }
  let parsed: { keywords?: unknown; code?: unknown }
  try {
    parsed = JSON.parse(data.response)
  } catch {
    parsed = {}
  }
  const out = {
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 16) : [],
    code: typeof parsed.code === 'string' ? parsed.code : '',
  }
  cache[key] = out
  writeFileSync(CACHE, JSON.stringify(cache, null, 1))
  return out
}

const matchOf = (wanted: Set<string>) => (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
  wanted.has(r.path) ||
  (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
  (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

interface RankedRow {
  id: string
  path: string
  symbol: string | null
  parent_chain: string[]
}

async function vecTop(v: number[]): Promise<RankedRow[]> {
  const { rows } = await db().query<RankedRow>(
    `SELECT l.id::text, l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
      ORDER BY c.embedding <=> $1::vector LIMIT $3`,
    [toVectorLiteral(v), modelId, LIMIT],
  )
  return rows
}

async function lexTop(terms: string[]): Promise<RankedRow[]> {
  if (!terms.length) return []
  const { rows } = await db().query<RankedRow>(
    `SELECT l.id::text, l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id,
            code_query($2) q
      WHERE r.name = 'unitify' AND c.model_id = $3 AND l.path NOT LIKE '@deleted/%'
        AND q != ''::tsquery AND c.tsv @@ q
      ORDER BY ts_rank(c.tsv, q) DESC LIMIT $1`,
    [LIMIT, terms.join(' '), modelId],
  )
  return rows
}

const VARIANTS = ['base', 'kw', 'hydeQ', 'hydeD', 'lex', 'rrf', 'oracle'] as const
type Variant = (typeof VARIANTS)[number]
const ranks: Record<Variant, (number | null)[]> = Object.fromEntries(VARIANTS.map((v) => [v, []])) as never
const hard: { q: string; base: number | null; per: Record<string, number | null> }[] = []

for (const entry of golden) {
  const wanted = new Set(entry.expect)
  const match = matchOf(wanted)
  const { keywords, code } = await gen(entry.q)

  const [vBase, vKw, vHydeQ] = await embedder.embed(
    [entry.q, `${entry.q}\n${keywords.join(' ')}`, code || entry.q],
    'query',
  )
  const [vHydeD] = await embedder.embed([code || entry.q], 'document')

  const lists: Record<string, RankedRow[]> = {
    base: await vecTop(vBase!),
    kw: await vecTop(vKw!),
    hydeQ: await vecTop(vHydeQ!),
    hydeD: await vecTop(vHydeD!),
    lex: await lexTop(keywords),
  }

  const rankIn = (rows: RankedRow[]) => {
    const i = rows.findIndex(match)
    return i < 0 ? null : i + 1
  }

  // RRF-слияние четырёх списков по id
  const fusedScore = new Map<string, number>()
  const meta = new Map<string, RankedRow>()
  for (const name of ['base', 'kw', 'hydeD', 'lex']) {
    lists[name]!.forEach((r, i) => {
      fusedScore.set(r.id, (fusedScore.get(r.id) ?? 0) + 1 / (60 + i + 1))
      meta.set(r.id, r)
    })
  }
  const fused = [...fusedScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => meta.get(id)!)

  const per: Record<string, number | null> = {}
  for (const name of ['base', 'kw', 'hydeQ', 'hydeD', 'lex'] as const) per[name] = rankIn(lists[name]!)
  per.rrf = rankIn(fused)
  per.oracle = ['base', 'kw', 'hydeQ', 'hydeD', 'lex'].map((n) => per[n]).reduce<number | null>(
    (m, r) => (r === null ? m : m === null ? r : Math.min(m, r)),
    null,
  )

  for (const v of VARIANTS) ranks[v].push(per[v] ?? null)
  if ((per.base ?? Infinity) > 50) hard.push({ q: entry.q, base: per.base ?? null, per })
  process.stderr.write('.')
}
process.stderr.write('\n')

const n = golden.length
const at = (rs: (number | null)[], k: number) => rs.filter((r) => r !== null && r <= k).length
console.log(`Модель генерации: ${MODEL}. Ранг ожидаемого ответа (живой код), n=${n}:\n`)
console.log('вариант      @5     @10     @50    @300   вне 1000   медиана')
for (const v of VARIANTS) {
  const rs = ranks[v]
  const found = rs.filter((r): r is number => r !== null).sort((a, b) => a - b)
  const med = found.length ? found[Math.floor(found.length / 2)] : null
  console.log(
    `${v.padEnd(8)} ${String(at(rs, 5)).padStart(6)} ${String(at(rs, 10)).padStart(7)} ${String(at(rs, 50)).padStart(7)} ` +
      `${String(at(rs, 300)).padStart(7)} ${String(n - found.length).padStart(8)} ${String(med ?? '—').padStart(9)}`,
  )
}

console.log('\nТрудные запросы (base > 50): ранги по вариантам')
console.log('base    kw  hydeQ  hydeD    lex    rrf  запрос')
for (const h of hard.sort((a, b) => (a.base ?? 9e9) - (b.base ?? 9e9))) {
  const f = (x: number | null | undefined) => String(x ?? '—').padStart(5)
  console.log(
    `${f(h.per.base)} ${f(h.per.kw)} ${f(h.per.hydeQ)} ${f(h.per.hydeD)} ${f(h.per.lex)} ${f(h.per.rrf)}  ${h.q.slice(0, 70)}`,
  )
}
writeFileSync(`scratch/out/qx-${MODEL.replace(/[:/]/g, '_')}.json`, JSON.stringify({ ranks, hard }, null, 1))
await closeDb()
