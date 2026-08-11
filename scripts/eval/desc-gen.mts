/**
 * Генерация «промежуточного представления назначения» для пула чанков:
 * на каждый запрос — топ-40 объединённой первой ступени + сами ожидаемые чанки
 * (иначе не измерить, находит ли описание то, что код-вектор не находит).
 *
 * Описание: 1-2 русских предложения о том, ЧТО фрагмент делает в терминах
 * предметной области, с упоминанием имени символа. Кэш по content_hash —
 * прогон можно прерывать и продолжать.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import './out-dir.js'
import { db, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'
import { loadGolden } from '../../src/eval/run.js'

const QX_MODEL = process.env.QX_MODEL ?? 'gemma3:latest'
const DESC_MODEL = process.env.DESC_MODEL ?? 'gemma3:latest'
const PER_QUERY = 40

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()
const modelId = await embedder.model()

const qxCache: Record<string, { keywords: string[]; code: string }> = JSON.parse(
  readFileSync('scratch/out/qx-cache.json', 'utf8'),
)

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

// ---- сбор пула ----
const poolIds = new Set<string>()
const perQueryPools: Record<string, string[]> = {}

for (const entry of golden) {
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
  const ids = [...fusedScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, PER_QUERY).map(([id]) => id)

  // ожидаемые чанки: любые живые локации, чей path::symbol или parent попадает в expect
  const paths = [...new Set(entry.expect.map((e) => e.split('::')[0]))]
  const { rows: expRows } = await db().query<{ id: string; path: string; symbol: string | null; parent_chain: string[] }>(
    `SELECT l.id::text, l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND l.path = ANY($1) AND l.path NOT LIKE '@deleted/%'`,
    [paths],
  )
  const wanted = new Set(entry.expect)
  for (const r of expRows) {
    const hit =
      wanted.has(r.path) ||
      (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
      (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))
    if (hit) ids.push(r.id)
  }

  perQueryPools[entry.q] = [...new Set(ids)]
  for (const id of perQueryPools[entry.q]!) poolIds.add(id)
  process.stderr.write('.')
}
writeFileSync('scratch/out/desc-pools.json', JSON.stringify(perQueryPools))
process.stderr.write(`\nпул: ${poolIds.size} локаций\n`)

// ---- уникальные тексты ----
const { rows: chunkRows } = await db().query<{ hash: string; embed_text: string; symbol: string | null; path: string }>(
  `SELECT DISTINCT encode(l.content_hash, 'hex') AS hash, c.embed_text, l.symbol, l.path
     FROM chunk_locations l JOIN chunks c USING (content_hash)
    WHERE l.id = ANY($1::bigint[])`,
  [[...poolIds]],
)
console.log(`уникальных текстов: ${chunkRows.length}`)

const CACHE = 'scratch/out/desc-cache.json'
const cache: Record<string, string> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

let done = 0
let t0 = Date.now()
for (const r of chunkRows) {
  const key = `${DESC_MODEL}::${r.hash}`
  if (!cache[key]) {
    const prompt =
      `Фрагмент кода из монорепы платформы управляющей компании (биллинг, платежи, заявки, приборы учёта).\n` +
      `Опиши в 1-2 предложениях по-русски его НАЗНАЧЕНИЕ: что он делает в терминах предметной области и когда вызывается. ` +
      `Упомяни имя символа. Не пересказывай реализацию построчно. Только описание, без преамбул.\n\n` +
      '```\n' + r.embed_text.slice(0, 4000) + '\n```'
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        model: DESC_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 160 },
      }),
    })
    const data = (await res.json()) as { response?: string }
    cache[key] = (data.response ?? '').trim()
    if (++done % 25 === 0) {
      writeFileSync(CACHE, JSON.stringify(cache))
      const rate = done / ((Date.now() - t0) / 1000)
      process.stderr.write(`\n${done} сгенерировано, ${rate.toFixed(1)}/с`)
    }
  }
}
writeFileSync(CACHE, JSON.stringify(cache))
console.log(`\nготово: ${chunkRows.length} описаний (новых ${done})`)
await closeDb()
