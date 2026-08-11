/**
 * Какие ветви мульти-представления запроса реально нужны.
 *
 * Продовое слияние в §3.2 RECALL85 собрано из base+kw+hydeD+lex, но в кэше
 * есть пятая ветвь hydeQ, и по одиночке она лучшая (@5=25 против base 22).
 * В таблице документа её нет, а в RRF она не участвует. Вопрос: не даёт ли
 * подмножество ветвей столько же, сколько все пять, — тогда этап 1 плана
 * дешевле, чем описан.
 *
 * Списки кандидатов считаются один раз и кэшируются: LLM-выводы уже лежат
 * в qx-cache.json, поэтому нужен только эмбеддер и БД. Дальше все 31
 * сочетание считаются офлайн.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import './out-dir.js'
import { db, toVectorLiteral, closeDb } from '../../src/store/pool.js'
import { Embedder } from '../../src/embed/client.js'
import { loadGolden } from '../../src/eval/run.js'

const MODEL = process.env.QX_MODEL ?? 'gemma3:latest'
const LIMIT = 1000
const BRANCHES = ['base', 'kw', 'hydeQ', 'hydeD', 'lex'] as const
type Branch = (typeof BRANCHES)[number]

const LISTS_CACHE = 'scratch/out/qx-lists-v2.json'
const golden = loadGolden('src/eval/golden.unitify.jsonl')

interface RankedRow {
  id: string
  path: string
  symbol: string | null
  parent_chain: string[]
}

/** Ранг ожидаемого ответа в каждой ветви + сами id для честного RRF. */
interface PerQuery {
  lists: Record<Branch, string[]>
  hit: Record<Branch, number | null>
  /** ВСЕ id, соответствующие ожидаемому ответу: у символа бывает несколько
   *  чанков, и слияние вправе поднять любой из них — как и считает qx.mts. */
  matches: string[]
}

async function buildLists(): Promise<PerQuery[]> {
  if (existsSync(LISTS_CACHE)) return JSON.parse(readFileSync(LISTS_CACHE, 'utf8')) as PerQuery[]

  const llm: Record<string, { keywords: string[]; code: string }> = JSON.parse(
    readFileSync('scratch/out/qx-cache.json', 'utf8'),
  )
  const embedder = new Embedder()
  const modelId = await embedder.model()

  const vecTop = async (v: number[]) =>
    (
      await db().query<RankedRow>(
        `SELECT l.id::text, l.path, l.symbol, l.parent_chain
           FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
          WHERE r.name = 'unitify' AND c.model_id = $2 AND l.path NOT LIKE '@deleted/%'
          ORDER BY c.embedding <=> $1::vector LIMIT $3`,
        [toVectorLiteral(v), modelId, LIMIT],
      )
    ).rows

  const lexTop = async (terms: string[]) =>
    terms.length
      ? (
          await db().query<RankedRow>(
            `SELECT l.id::text, l.path, l.symbol, l.parent_chain
               FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id,
                    code_query($2) q
              WHERE r.name = 'unitify' AND c.model_id = $3 AND l.path NOT LIKE '@deleted/%'
                AND q != ''::tsquery AND c.tsv @@ q
              ORDER BY ts_rank(c.tsv, q) DESC LIMIT $1`,
            [LIMIT, terms.join(' '), modelId],
          )
        ).rows
      : []

  const out: PerQuery[] = []
  for (const entry of golden) {
    const wanted = new Set(entry.expect)
    const match = (r: RankedRow) =>
      wanted.has(r.path) ||
      (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
      (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`))

    const gen = llm[`${MODEL}::${entry.q}`] ?? { keywords: [], code: '' }
    const [vBase, vKw, vHydeQ] = await embedder.embed(
      [entry.q, `${entry.q}\n${gen.keywords.join(' ')}`, gen.code || entry.q],
      'query',
    )
    const [vHydeD] = await embedder.embed([gen.code || entry.q], 'document')

    const rows: Record<Branch, RankedRow[]> = {
      base: await vecTop(vBase!),
      kw: await vecTop(vKw!),
      hydeQ: await vecTop(vHydeQ!),
      hydeD: await vecTop(vHydeD!),
      lex: await lexTop(gen.keywords),
    }

    const lists = {} as Record<Branch, string[]>
    const hit = {} as Record<Branch, number | null>
    const matches = new Set<string>()
    for (const b of BRANCHES) {
      lists[b] = rows[b].map((r) => r.id)
      const i = rows[b].findIndex(match)
      hit[b] = i < 0 ? null : i + 1
      for (const r of rows[b]) if (match(r)) matches.add(r.id)
    }
    out.push({ lists, hit, matches: [...matches] })
    process.stderr.write('.')
  }
  process.stderr.write('\n')
  writeFileSync(LISTS_CACHE, JSON.stringify(out))
  return out
}

const data = await buildLists()

/** Ранг ожидаемого ответа после RRF-слияния подмножества ветвей. */
function rrfRank(q: PerQuery, subset: Branch[], k = 60): number | null {
  const score = new Map<string, number>()
  for (const b of subset) {
    q.lists[b].forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  }
  const want = new Set(q.matches)
  if (!want.size) return null
  const sorted = [...score.entries()].sort((a, b) => b[1] - a[1])
  const i = sorted.findIndex(([id]) => want.has(id))
  return i < 0 ? null : i + 1
}

/** Доступность при квотированном union: ответ в top-N хотя бы одной ветви. */
function unionAvail(q: PerQuery, subset: Branch[], depth: number): boolean {
  return subset.some((b) => {
    const r = q.hit[b]
    return r !== null && r <= depth
  })
}

const combos: Branch[][] = []
for (let mask = 1; mask < 1 << BRANCHES.length; mask++) {
  combos.push(BRANCHES.filter((_, i) => mask & (1 << i)))
}

const at = (rs: (number | null)[], k: number) => rs.filter((r) => r !== null && r <= k).length

interface Row {
  subset: string
  size: number
  rrf5: number
  rrf10: number
  union50: number
  cands: number
}
const results: Row[] = combos.map((subset) => {
  const rrf = data.map((q) => rrfRank(q, subset))
  return {
    subset: subset.join('+'),
    size: subset.length,
    rrf5: at(rrf, 5),
    rrf10: at(rrf, 10),
    union50: data.filter((q) => unionAvail(q, subset, 50)).length,
    cands: subset.length * 50,
  }
})

console.log(`n = ${data.length} запросов. RRF — качество порядка, union@50 — потолок доступности.\n`)
console.log('ветви                          RRF@5  RRF@10  union@50  кандидатов')
for (const r of [...results].sort((a, b) => b.rrf5 - a.rrf5 || a.size - b.size).slice(0, 12)) {
  console.log(
    `${r.subset.padEnd(30)} ${String(r.rrf5).padStart(5)} ${String(r.rrf10).padStart(7)} ` +
      `${String(r.union50).padStart(9)} ${String(r.cands).padStart(11)}`,
  )
}

console.log('\nПродовый вариант из RECALL85 §3.2 и одиночные ветви:')
for (const name of ['base+kw+hydeD+lex', 'base', 'kw', 'hydeQ', 'hydeD', 'lex']) {
  const r = results.find((x) => x.subset === name)!
  console.log(
    `${r.subset.padEnd(30)} ${String(r.rrf5).padStart(5)} ${String(r.rrf10).padStart(7)} ` +
      `${String(r.union50).padStart(9)} ${String(r.cands).padStart(11)}`,
  )
}

// Предельный вклад ветви: что теряется, если её убрать из полного набора.
console.log('\nПредельный вклад ветви (полный набор минус она):')
const full = results.find((r) => r.size === BRANCHES.length)!
for (const b of BRANCHES) {
  const without = results.find((r) => r.subset === BRANCHES.filter((x) => x !== b).join('+'))!
  console.log(
    `  без ${b.padEnd(8)} RRF@5 ${String(without.rrf5).padStart(3)} (${without.rrf5 - full.rrf5 >= 0 ? '+' : ''}${without.rrf5 - full.rrf5})` +
      `   union@50 ${String(without.union50).padStart(3)} (${without.union50 - full.union50 >= 0 ? '+' : ''}${without.union50 - full.union50})`,
  )
}

await closeDb()
