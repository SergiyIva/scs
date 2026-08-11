/** Точный перебор vs HNSW-ветка search() для одного запроса: кого теряет индекс. */
import { db, tx, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'

const q = process.argv[2] ?? 'как проверяется, что адрес для подтверждения продавца, присланный с устройства, действительно принадлежит Apple'
const embedder = new Embedder()
const modelId = await embedder.model()
const [v] = await embedder.embed([q], 'query')
const lit = toVectorLiteral(v!)

const exact = await db().query<{ path: string; symbol: string | null; sim: string }>(
  `SELECT l.path, l.symbol, (1 - (c.embedding <=> $1::vector))::text AS sim
     FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
    WHERE r.name = 'unitify' AND c.model_id = $2
    ORDER BY c.embedding <=> $1::vector LIMIT 10`,
  [lit, modelId],
)
console.log('ТОЧНЫЙ перебор, топ-10:')
for (const [i, r] of exact.rows.entries())
  console.log(`  ${i + 1}. ${Number(r.sim).toFixed(3)}  ${r.path}::${r.symbol ?? ''}`)

// Точная копия векторной ветки search(): HNSW по chunks, потом join локаций
const hnsw = await tx(async (c) => {
  await c.query(`SET LOCAL hnsw.ef_search = 200`)
  await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
  return c.query<{ path: string; symbol: string | null; sim: string }>(
    `SELECT l.path, l.symbol, (1 - cand.dist)::text AS sim
       FROM (SELECT content_hash, embedding <=> $1::vector AS dist
               FROM chunks
              WHERE $1::vector IS NOT NULL AND model_id = $2
              ORDER BY embedding <=> $1::vector
              LIMIT 100) cand
       JOIN chunk_locations l ON l.content_hash = cand.content_hash
      WHERE l.repo_id = (SELECT id FROM repos WHERE name = 'unitify')
      ORDER BY cand.dist LIMIT 10`,
    [lit, modelId],
  )
})
console.log('\nHNSW-ветка search(), топ-10:')
for (const [i, r] of hnsw.rows.entries())
  console.log(`  ${i + 1}. ${Number(r.sim).toFixed(3)}  ${r.path}::${r.symbol ?? ''}`)

await closeDb()
