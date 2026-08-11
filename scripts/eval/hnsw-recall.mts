/**
 * HNSW против точного перебора на всех запросах golden-набора:
 * сколько кандидатов теряет индекс и теряет ли он ожидаемый ответ.
 */
import { db, tx, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'
import { loadGolden } from '../../src/eval/run.js'

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()
const modelId = await embedder.model()

const K = 50
let overlapSum = 0
let expExactIn50 = 0
let expHnswIn50 = 0
const worst: { q: string; overlap: number }[] = []

for (const entry of golden) {
  const wanted = new Set(entry.expect)
  const [v] = await embedder.embed([entry.q], 'query')
  const lit = toVectorLiteral(v!)

  const match = (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
    wanted.has(r.path) ||
    (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
    (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

  const exact = await db().query<{ id: string; path: string; symbol: string | null; parent_chain: string[] }>(
    `SELECT l.id::text, l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2
      ORDER BY c.embedding <=> $1::vector LIMIT $3`,
    [lit, modelId, K],
  )

  const hnsw = await tx(async (c) => {
    await c.query(`SET LOCAL hnsw.ef_search = 200`)
    await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    return c.query<{ id: string; path: string; symbol: string | null; parent_chain: string[] }>(
      `SELECT l.id::text, l.path, l.symbol, l.parent_chain
         FROM (SELECT content_hash, embedding <=> $1::vector AS dist
                 FROM chunks
                WHERE $1::vector IS NOT NULL AND model_id = $2
                ORDER BY embedding <=> $1::vector
                LIMIT $3 * 2) cand
         JOIN chunk_locations l ON l.content_hash = cand.content_hash
        WHERE l.repo_id = (SELECT id FROM repos WHERE name = 'unitify')
        ORDER BY cand.dist LIMIT $3`,
      [lit, modelId, K],
    )
  })

  const exactIds = new Set(exact.rows.map((r) => r.id))
  const overlap = hnsw.rows.filter((r) => exactIds.has(r.id)).length / Math.max(1, exact.rows.length)
  overlapSum += overlap
  if (exact.rows.some(match)) expExactIn50++
  if (hnsw.rows.some(match)) expHnswIn50++
  worst.push({ q: entry.q, overlap })
  process.stderr.write('.')
}
process.stderr.write('\n')

console.log(`Среднее пересечение топ-${K} HNSW с точным: ${((overlapSum / golden.length) * 100).toFixed(1)}%`)
console.log(`Ожидаемый ответ в точном топ-${K}:  ${expExactIn50}/${golden.length}`)
console.log(`Ожидаемый ответ в HNSW топ-${K}:   ${expHnswIn50}/${golden.length}`)
console.log('\nХудшие 10 запросов по пересечению:')
for (const w of worst.sort((a, b) => a.overlap - b.overlap).slice(0, 10))
  console.log(`  ${(w.overlap * 100).toFixed(0).padStart(3)}%  ${w.q.slice(0, 80)}`)
await closeDb()
