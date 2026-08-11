/**
 * Каскад: точный векторный топ-300 → cross-encoder по всей глубине → пост-обработка.
 *
 * Отвечает на вопрос: сколько из 36 п.п. между @5 и @300 достаёт ТЕКУЩИЙ
 * cross-encoder, если дать ему пул глубже двадцати, и какое слияние при этом
 * не роняет @1. CE-скоры кэшируются в scratch/out/ce-cache.json — последующие
 * прогоны и другие эксперименты читают кэш.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { db, toVectorLiteral, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { Reranker } from '../src/rerank/client.js'
import { loadGolden } from '../src/eval/run.js'
import { loadConfig } from '../src/config.js'
import { compilePriors } from '../src/store/priors.js'
import type { SearchHit } from '../src/types.js'

const DEPTH = 300
const golden = loadGolden('src/eval/golden.unitify.jsonl')
const cfg = loadConfig()
const priors = compilePriors(cfg)
const embedder = new Embedder()
const modelId = await embedder.model()
const reranker = new Reranker(undefined, 300_000)

interface Cand {
  path: string
  symbol: string | null
  kind: string
  parent_chain: string[]
  lang: string
  embed_text: string
  vecRank: number // ранг в точном векторном порядке (с историей)
  prior: number
  ce?: number
}

const CACHE = 'scratch/out/ce-cache.json'
const ceCache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

const matchOf = (wanted: Set<string>) => (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
  wanted.has(r.path) ||
  (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
  (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

const perQuery: { q: string; expect: string[]; cands: Cand[] }[] = []

for (const entry of golden) {
  const [v] = await embedder.embed([entry.q], 'query')
  const { rows } = await db().query<Cand & { parent_chain: string[] }>(
    `SELECT l.path, l.symbol, l.kind, l.parent_chain, l.lang, c.embed_text
       FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2
      ORDER BY c.embedding <=> $1::vector LIMIT $3`,
    [toVectorLiteral(v!), modelId, DEPTH],
  )
  const cands: Cand[] = rows.map((r, i) => ({
    ...r,
    vecRank: i + 1,
    prior: priors.apply({ path: r.path, symbol: r.symbol, kind: r.kind, lang: r.lang } as unknown as SearchHit),
  }))

  let ce = ceCache[entry.q]
  if (!ce || ce.length !== cands.length) {
    const scores = await reranker.score(entry.q, cands.map((c) => c.embed_text))
    if (!scores) throw new Error('реранкер недоступен')
    ce = scores
    ceCache[entry.q] = scores
    writeFileSync(CACHE, JSON.stringify(ceCache))
  }
  cands.forEach((c, i) => (c.ce = ce![i]))
  perQuery.push({ q: entry.q, expect: entry.expect, cands })
  process.stderr.write('.')
}
process.stderr.write('\n')

function evalVariant(
  depth: number,
  fusion: 'rrf' | 'replace',
  w: number,
): { at1: number; at5: number; at10: number; mrr: number } {
  let h1 = 0, h5 = 0, h10 = 0, mrr = 0
  for (const { expect, cands } of perQuery) {
    const match = matchOf(new Set(expect))
    // базовый порядок пайплайна: vec-скор × prior
    const base = [...cands].sort(
      (a, b) => b.prior / (cfg.search.rrfK + b.vecRank) - a.prior / (cfg.search.rrfK + a.vecRank) || a.vecRank - b.vecRank,
    )
    const head = base.slice(0, depth)
    const tail = base.slice(depth)
    const byCe = [...head].sort((a, b) => b.ce! * b.prior - a.ce! * a.prior)
    let ordered: Cand[]
    if (fusion === 'replace') {
      ordered = [...byCe, ...tail]
    } else {
      const ceRank = new Map(byCe.map((c, i) => [c, i + 1]))
      ordered = [
        ...head
          .map((c, i) => ({ c, s: 1 / (cfg.search.rrfK + i + 1) + w / (cfg.search.rrfK + ceRank.get(c)!) }))
          .sort((a, b) => b.s - a.s)
          .map((x) => x.c),
        ...tail,
      ]
    }
    const rank = ordered.findIndex(match) + 1
    if (rank > 0) {
      if (rank <= 1) h1++
      if (rank <= 5) h5++
      if (rank <= 10) h10++
      mrr += 1 / rank
    }
  }
  const n = perQuery.length
  return { at1: h1 / n, at5: h5 / n, at10: h10 / n, mrr: mrr / n }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
console.log('глубина  слияние      вес     @1      @5     @10    MRR')
for (const depth of [20, 50, 100, 200, 300]) {
  for (const [fusion, w] of [
    ['rrf', 0.5], ['rrf', 1], ['rrf', 2], ['rrf', 4], ['replace', 0],
  ] as ['rrf' | 'replace', number][]) {
    const r = evalVariant(depth, fusion, w)
    console.log(
      `${String(depth).padStart(7)}  ${fusion.padEnd(8)} ${String(w).padStart(5)}  ${pct(r.at1)} ${pct(r.at5)} ${pct(r.at10)}  ${r.mrr.toFixed(3)}`,
    )
  }
}

// контроль: без реранкера вообще (vec×prior), на каждой глубине одинаково
{
  let h5 = 0
  for (const { expect, cands } of perQuery) {
    const match = matchOf(new Set(expect))
    const base = [...cands].sort(
      (a, b) => b.prior / (cfg.search.rrfK + b.vecRank) - a.prior / (cfg.search.rrfK + a.vecRank) || a.vecRank - b.vecRank,
    )
    if (base.slice(0, 5).some(match)) h5++
  }
  console.log(`\nбез реранкера (vec×prior): @5 = ${pct(h5 / perQuery.length)}`)
}
await closeDb()
