/**
 * Замер «промежуточного представления назначения» на общем пуле (§18-стиль):
 * ранжирование запроса против кода, против описаний и их слияния.
 *
 * Общий пул = объединение пулов всех запросов (~2k локаций) — это жёстче,
 * чем пул одного запроса, и ближе к реальному корпусу.
 */
import { readFileSync } from 'node:fs'
import { db, closeDb } from '../src/store/pool.js'
import { Embedder } from '../src/embed/client.js'
import { loadGolden } from '../src/eval/run.js'

const DESC_MODEL = process.env.DESC_MODEL ?? 'gemma3:latest'
const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()

const pools: Record<string, string[]> = JSON.parse(readFileSync('scratch/out/desc-pools.json', 'utf8'))
const descCache: Record<string, string> = JSON.parse(readFileSync('scratch/out/desc-cache.json', 'utf8'))

const allIds = [...new Set(Object.values(pools).flat())]
const { rows } = await db().query<{
  id: string
  hash: string
  path: string
  symbol: string | null
  kind: string
  parent_chain: string[]
  emb: string
}>(
  `SELECT l.id::text, encode(l.content_hash,'hex') AS hash, l.path, l.symbol, l.kind,
          l.parent_chain, c.embedding::text AS emb
     FROM chunk_locations l JOIN chunks c USING (content_hash)
    WHERE l.id = ANY($1::bigint[])`,
  [allIds],
)
console.log(`пул: ${rows.length} локаций`)

interface Item {
  id: string
  path: string
  symbol: string | null
  parent_chain: string[]
  codeVec: Float64Array
  descVec: Float64Array | null
  desc: string
}

const parseVec = (s: string) => Float64Array.from(s.slice(1, -1).split(','), Number)
const norm = (v: Float64Array) => {
  let s = 0
  for (const x of v) s += x * x
  s = Math.sqrt(s) || 1
  return Float64Array.from(v, (x) => x / s)
}
const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

// эмбеддинг описаний (батчами), кэшируем в памяти по hash
const hashes = [...new Set(rows.map((r) => r.hash))]
const descByHash = new Map<string, string>()
for (const h of hashes) descByHash.set(h, descCache[`${DESC_MODEL}::${h}`] ?? '')
const withDesc = hashes.filter((h) => descByHash.get(h))
console.log(`описаний: ${withDesc.length}/${hashes.length}`)

const descVecs = new Map<string, Float64Array>()
const B = 64
for (let i = 0; i < withDesc.length; i += B) {
  const batch = withDesc.slice(i, i + B)
  const vs = await embedder.embed(batch.map((h) => descByHash.get(h)!), 'document')
  batch.forEach((h, j) => descVecs.set(h, norm(Float64Array.from(vs[j]!))))
  process.stderr.write('.')
}
process.stderr.write('\n')

const items: Item[] = rows.map((r) => ({
  id: r.id,
  path: r.path,
  symbol: r.symbol,
  parent_chain: r.parent_chain,
  codeVec: norm(parseVec(r.emb)),
  descVec: descVecs.get(r.hash) ?? null,
  desc: descByHash.get(r.hash) ?? '',
}))

const matchOf = (wanted: Set<string>) => (r: { path: string; symbol: string | null; parent_chain: string[] }) =>
  wanted.has(r.path) ||
  (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
  (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

const gap: { q: string; vecRank: number | null }[] = JSON.parse(readFileSync('scratch/out/gap.json', 'utf8'))
const hardSet = new Set(gap.filter((g) => g.vecRank === null || g.vecRank > 50).map((g) => g.q))

const variants = ['code', 'desc', 'max', 'rrf'] as const
const ranks: Record<string, (number | null)[]> = { code: [], desc: [], max: [], rrf: [] }
const hardRows: { q: string; per: Record<string, number | null> }[] = []

const qVecs = await embedder.embed(golden.map((g) => g.q), 'query')

for (const [qi, entry] of golden.entries()) {
  const qv = norm(Float64Array.from(qVecs[qi]!))
  const match = matchOf(new Set(entry.expect))

  const scored = items.map((it) => {
    const c = dot(qv, it.codeVec)
    const d = it.descVec ? dot(qv, it.descVec) : -1
    return { it, c, d }
  })
  const byCode = [...scored].sort((a, b) => b.c - a.c)
  const byDesc = [...scored].sort((a, b) => b.d - a.d)
  const codeRank = new Map(byCode.map((s, i) => [s.it.id, i + 1]))
  const descRank = new Map(byDesc.map((s, i) => [s.it.id, i + 1]))
  const byMax = [...scored].sort((a, b) => Math.max(b.c, b.d) - Math.max(a.c, a.d))
  const byRrf = [...scored].sort(
    (a, b) =>
      1 / (60 + codeRank.get(b.it.id)!) + 1 / (60 + descRank.get(b.it.id)!) -
      (1 / (60 + codeRank.get(a.it.id)!) + 1 / (60 + descRank.get(a.it.id)!)),
  )

  const rankIn = (list: { it: Item }[]) => {
    const i = list.findIndex((s) => match(s.it))
    return i < 0 ? null : i + 1
  }
  const per: Record<string, number | null> = {
    code: rankIn(byCode),
    desc: rankIn(byDesc),
    max: rankIn(byMax),
    rrf: rankIn(byRrf),
  }
  for (const v of variants) ranks[v]!.push(per[v]!)
  if (hardSet.has(entry.q)) hardRows.push({ q: entry.q, per })
}

const n = golden.length
console.log(`\nОбщий пул ${items.length} локаций, ${withDesc.length} описаний (${DESC_MODEL}). Ранг ответа:\n`)
console.log('вариант     @1     @5    @10    MRR')
for (const v of variants) {
  const rs = ranks[v]!
  const at = (k: number) => rs.filter((r) => r !== null && r <= k).length / n
  const mrr = rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n
  console.log(
    `${v.padEnd(6)} ${(at(1) * 100).toFixed(1).padStart(6)}% ${(at(5) * 100).toFixed(1).padStart(5)}% ${(at(10) * 100).toFixed(1).padStart(6)}%  ${mrr.toFixed(3)}`,
  )
}

console.log('\nТрудные запросы (в полном корпусе код-вектор > 50 или не найден): ранги в пуле')
console.log(' code   desc    max    rrf  запрос')
for (const h of hardRows) {
  const f = (x: number | null) => String(x ?? '—').padStart(5)
  console.log(`${f(h.per.code!)} ${f(h.per.desc!)} ${f(h.per.max!)} ${f(h.per.rrf!)}  ${h.q.slice(0, 72)}`)
}
await closeDb()
