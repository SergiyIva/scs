/**
 * Пофакторный разбор разрыва до 85%: для каждого запроса golden-набора —
 * ранг ожидаемого ответа в чистом векторе (с историей git и без) и в полном
 * пайплайне (priors + rerank RRF), плюс вид ожидаемого чанка.
 */
import { writeFileSync } from 'node:fs'
import './out-dir.js'
import { db, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'
import { search } from '../../src/store/search.js'
import { loadGolden } from '../../src/eval/run.js'

const DEPTH = 3000
const golden = loadGolden('src/eval/golden.unitify.jsonl')
const embedder = new Embedder()
const modelId = await embedder.model()

interface Loc {
  path: string
  symbol: string | null
  parent_chain: string[]
}

function isMatch(r: Loc, wanted: Set<string>): boolean {
  if (wanted.has(r.path)) return true
  if (r.symbol && r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`))) return true
  return (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))
}

const out: {
  q: string
  expect: string[]
  kind: string | null
  vecRank: number | null // без истории
  vecRankHist: number | null // с историей
  pipeRank: number | null // полный пайплайн (priors+rerank), k=60
  top1: string
}[] = []

for (const entry of golden) {
  const wanted = new Set(entry.expect)
  const [v] = await embedder.embed([entry.q], 'query')
  const lit = toVectorLiteral(v!)

  const { rows } = await db().query<Loc & { kind: string }>(
    `SELECT l.path, l.symbol, l.parent_chain, l.kind
       FROM chunk_locations l
       JOIN chunks c USING (content_hash)
       JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND c.model_id = $2
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    [lit, modelId, DEPTH],
  )

  let vecRank: number | null = null
  let vecRankHist: number | null = null
  let live = 0
  for (const [i, r] of rows.entries()) {
    const isHist = r.path.startsWith('@deleted/')
    if (!isHist) live++
    if (isMatch(r, wanted)) {
      if (vecRankHist === null) vecRankHist = i + 1
      if (!isHist && vecRank === null) {
        vecRank = live
        break
      }
    }
  }

  const hits = await search({ repo: 'unitify', query: entry.q, k: 60, maxPerFile: 99, rerank: true })
  let pipeRank: number | null = null
  for (const [i, h] of hits.entries()) {
    const keys = [h.path]
    if (h.symbol) for (const s of h.symbol.split(',')) keys.push(`${h.path}::${s.trim()}`)
    for (const p of h.parentChain) keys.push(`${h.path}::${p}`)
    if (keys.some((k) => wanted.has(k))) {
      pipeRank = i + 1
      break
    }
  }

  // вид ожидаемого чанка (какой kind у совпадающей локации)
  const { rows: kindRows } = await db().query<{ kind: string; path: string; symbol: string | null; parent_chain: string[] }>(
    `SELECT l.kind, l.path, l.symbol, l.parent_chain
       FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
      WHERE r.name = 'unitify' AND l.path = ANY($1) AND l.path NOT LIKE '@deleted/%'`,
    [[...new Set(entry.expect.map((e) => e.split('::')[0]))]],
  )
  const matching = kindRows.filter((r) => isMatch(r, wanted))
  const kind = matching[0]?.kind ?? null

  out.push({
    q: entry.q,
    expect: entry.expect,
    kind,
    vecRank,
    vecRankHist,
    pipeRank,
    top1: rows[0] ? `${rows[0].path}::${rows[0].symbol ?? rows[0].kind}` : '',
  })
  process.stderr.write('.')
}
process.stderr.write('\n')

// ---- сводка ----
const buckets: [string, (r: number | null) => boolean][] = [
  ['1-5    (уже попадаем)', (r) => r !== null && r <= 5],
  ['6-10', (r) => r !== null && r >= 6 && r <= 10],
  ['11-20  (в пуле реранкера)', (r) => r !== null && r >= 11 && r <= 20],
  ['21-50', (r) => r !== null && r >= 21 && r <= 50],
  ['51-100', (r) => r !== null && r >= 51 && r <= 100],
  ['101-300', (r) => r !== null && r >= 101 && r <= 300],
  [`301-${DEPTH}`, (r) => r !== null && r > 300],
  [`вне ${DEPTH}`, (r) => r === null],
]

console.log(`Ранг ожидаемого ответа в чистом векторе (без истории git), n=${out.length}:`)
for (const [name, f] of buckets) {
  const n = out.filter((o) => f(o.vecRank)).length
  console.log(`  ${name.padEnd(28)} ${String(n).padStart(3)}  (${((n / out.length) * 100).toFixed(1)}%)`)
}

console.log('\nПолный пайплайн (priors+rerank, с историей): recall@5 =',
  `${((out.filter((o) => o.pipeRank !== null && o.pipeRank <= 5).length / out.length) * 100).toFixed(1)}%`)

console.log('\nЗапросы вне топ-5 пайплайна, отсортированы по векторному рангу:')
console.log('vec(live)  vec(hist)  pipe  kind        запрос')
for (const o of out.filter((o) => !(o.pipeRank !== null && o.pipeRank <= 5)).sort((a, b) => (a.vecRank ?? 9e9) - (b.vecRank ?? 9e9))) {
  console.log(
    `${String(o.vecRank ?? '—').padStart(8)}  ${String(o.vecRankHist ?? '—').padStart(9)}  ${String(o.pipeRank ?? '—').padStart(4)}  ${(o.kind ?? '—').padEnd(10)}  ${o.q.slice(0, 90)}`,
  )
}

writeFileSync('scratch/out/gap.json', JSON.stringify(out, null, 2))
console.log('\nПолные данные: scratch/out/gap.json')
await closeDb()
