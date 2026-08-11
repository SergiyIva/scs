/**
 * «Этап 0»: текущий пайплайн (вектор → priors → CE топ-20, RRF 0.5),
 * но кандидаты без истории git (@deleted). Ремонт HNSW уже сделан.
 * Ровно то, что даст флаг search.includeDeleted=false, без прочих изменений.
 */
import { db, toVectorLiteral, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { Reranker } from '../src/rerank/client.js'
import { loadGolden } from '../src/eval/run.js'
import { loadConfig } from '../src/config.js'
import { compilePriors } from '../src/store/priors.js'
import type { SearchHit } from '../src/types.js'

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const cfg = loadConfig()
const priors = compilePriors(cfg)
const embedder = new Embedder()
const modelId = await embedder.model()
const reranker = new Reranker(undefined, 300_000)

const matchOf = (wanted: Set<string>) => (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
  wanted.has(r.path) ||
  (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
  (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

let h1 = 0, h5 = 0, h10 = 0, mrr = 0
for (const entry of golden) {
  const match = matchOf(new Set(entry.expect))
  const [v] = await embedder.embed([entry.q], 'query')
  const { rows } = await db().query<{
    path: string; symbol: string | null; kind: string; parent_chain: string[]; lang: string; embed_text: string
  }>(
    `SELECT l.path, l.symbol, l.kind, l.parent_chain, l.lang, c.embed_text
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
      ORDER BY c.embedding <=> $1::vector LIMIT 50`,
    [toVectorLiteral(v!), modelId],
  )
  const prior = (r: (typeof rows)[0]) =>
    priors.apply({ path: r.path, symbol: r.symbol, kind: r.kind, lang: r.lang } as unknown as SearchHit)
  const base = rows
    .map((r, i) => ({ r, s: prior(r) / (cfg.search.rrfK + i + 1) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r)

  const head = base.slice(0, 20)
  const ce = await reranker.score(entry.q, head.map((r) => r.embed_text))
  if (!ce) throw new Error('реранкер недоступен')
  const byCe = [...head.keys()].sort((a, b) => ce[b]! * prior(head[b]!) - ce[a]! * prior(head[a]!))
  const ceRank = new Map(byCe.map((hi, i) => [hi, i + 1]))
  const ordered = [
    ...head
      .map((r, i) => ({ r, s: 1 / (60 + i + 1) + 0.5 / (60 + ceRank.get(i)!) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r),
    ...base.slice(20),
  ]
  const rank = ordered.findIndex(match) + 1
  if (rank > 0) {
    if (rank <= 1) h1++
    if (rank <= 5) h5++
    if (rank <= 10) h10++
    mrr += 1 / rank
  }
  process.stderr.write('.')
}
const n = golden.length
console.log(
  `\nЭтап 0 (без @deleted, HNSW починен): @1 ${((h1 / n) * 100).toFixed(1)}%  @5 ${((h5 / n) * 100).toFixed(1)}%  @10 ${((h10 / n) * 100).toFixed(1)}%  MRR ${(mrr / n).toFixed(3)}`,
)
await closeDb()
