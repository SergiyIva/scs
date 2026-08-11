/**
 * Судья над СОКРАЩЁННЫМ union (base+kw+hydeQ, глубина 55).
 *
 * Замер qx-window показал: в union доступно 53/58, но в топ-30 слияния —
 * только 40. Тринадцать ответов стоят на рангах 33–122, и поветвевая квота
 * их не спасает (в своих ветвях они на рангах 20–190, а не в топ-8).
 * Значит выбор такой: либо судья видит весь union, либо эти 13 недостижимы
 * в принципе.
 *
 *   window30 — контроль: судья по топ-30 слияния (как в §3.4 RECALL85)
 *   batched  — весь union батчами по 30 в порядке слияния, из каждого батча
 *              судья берёт до 8, затем финальный listwise по выжившим
 *
 * Все выводы кэшируются: повторный прогон бесплатен.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import './out-dir.js'
import { createHash } from 'node:crypto'
import { db, closeDb } from '../../src/store/pool.js'
import { loadGolden } from '../../src/eval/run.js'

const RR_MODEL = process.env.RR_MODEL ?? 'qwen3-vl:8b'
const DEPTH = 55
const BATCH = 30
const PER_BATCH = 8
const BR = ['base', 'kw', 'hydeQ'] as const
type B = (typeof BR)[number]

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const lists: { lists: Record<string, string[]>; hit: Record<string, number | null>; matches: string[] }[] =
  JSON.parse(readFileSync('scratch/out/qx-lists-v2.json', 'utf8'))
if (lists.length !== golden.length) {
  // Кэш и набор сопоставляются по индексу, поэтому расхождение длин означает
  // молча перепутанные запросы, а не мелкое неудобство.
  throw new Error(
    `кэш списков не соответствует набору: lists ${lists.length} против golden ${golden.length}. ` +
      'Удалите scratch/out/qx-lists-v2.json и пересоберите.',
  )
}

const CACHE = 'scratch/out/stage2b-cache.json'
const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

interface Row {
  id: string
  path: string
  symbol: string | null
  kind: string
  raw_text: string
  embed_text: string
}

async function fetchRows(ids: string[]): Promise<Map<string, Row>> {
  const { rows } = await db().query<Row>(
    `SELECT l.id::text, l.path, l.symbol, l.kind, c.raw_text, c.embed_text
       FROM chunk_locations l JOIN chunks c USING (content_hash)
      WHERE l.id = ANY($1::bigint[])`,
    [ids],
  )
  return new Map(rows.map((r) => [r.id, r]))
}

const docLine = (t: string) => t.match(/^\/\/ doc: (.+)$/m)?.[1] ?? ''

function card(r: Row, i: number): string {
  const code = r.raw_text.split('\n').slice(0, 6).join('\n')
  const doc = docLine(r.embed_text)
  return `[${i}] ${r.path} :: ${r.symbol ?? r.kind}${doc ? `\n// ${doc}` : ''}\n${code}`
}

async function judge(q: string, cands: Row[], take: number, allowEmpty: boolean): Promise<number[]> {
  const key = createHash('sha256')
    .update(`${RR_MODEL}::${take}::${allowEmpty}::${q}::${cands.map((c) => c.id).join(',')}`)
    .digest('hex')
  if (cache[key]) return cache[key]

  const prompt =
    `Вопрос разработчика о JS/TS-монорепе: «${q}»\n\n` +
    `Ниже ${cands.length} фрагментов-кандидатов. Определи, какие из них реализуют то, о чём спрашивают ` +
    `(не тесты и не документацию, если есть реализация). ` +
    (allowEmpty
      ? `Если ни один фрагмент не отвечает на вопрос — верни пустой список: лучше пропустить, чем додумать. `
      : '') +
    `Верни JSON {"ranking": [индексы до ${take} лучших, от лучшего к худшему]}.\n\n` +
    cands.map((c, i) => card(c, i)).join('\n\n')

  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: RR_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0, num_predict: 200, num_ctx: 16384 },
    }),
  })
  const data = (await res.json()) as { response: string; thinking?: string }
  let out: number[] = []
  try {
    const parsed = JSON.parse(data.response || data.thinking || '') as { ranking?: unknown }
    if (Array.isArray(parsed.ranking)) {
      out = [...new Set(parsed.ranking.map(Number))].filter(
        (x) => Number.isInteger(x) && x >= 0 && x < cands.length,
      )
    }
  } catch {
    /* пустой ответ = судья промолчал */
  }
  cache[key] = out
  writeFileSync(CACHE, JSON.stringify(cache))
  return out
}

const fuse = (pool: Row[], picked: Map<string, number>, w: number) =>
  pool
    .map((r, i) => ({ r, s: 1 / (60 + i + 1) + (picked.has(r.id) ? w / (60 + picked.get(r.id)!) : 0) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r)

const deep: { q: string; fusedRank: number; batch: number; reached: boolean }[] = []
const results: Record<string, (number | null)[]> = {}
const push = (n: string, r: number | null) => (results[n] ??= []).push(r)

for (const [qi, entry] of golden.entries()) {
  const q = entry.q
  const cached = lists[qi]!
  const want = new Set(cached.matches)

  // union и порядок слияния
  const score = new Map<string, number>()
  for (const b of BR) {
    ;(cached.lists[b] ?? []).slice(0, DEPTH).forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)))
  }
  const order = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const rowMap = await fetchRows(order)
  const pool = order.map((id) => rowMap.get(id)).filter(Boolean) as Row[]

  const rankOf = (rows: Row[]) => {
    const i = rows.findIndex((r) => want.has(r.id))
    return i < 0 ? null : i + 1
  }

  push('pool', rankOf(pool))

  // 1. Контроль: судья по топ-30 слияния
  const head = pool.slice(0, BATCH)
  const jHead = await judge(q, head, 10, false)
  push('window30', rankOf(fuse(pool, new Map(jHead.map((idx, i) => [head[idx]!.id, i + 1])), 2)))

  // 2. Каскад: весь union батчами, затем финальный отбор
  const finalists: Row[] = []
  for (let s = 0; s < pool.length; s += BATCH) {
    const batch = pool.slice(s, s + BATCH)
    const picked = await judge(q, batch, PER_BATCH, true)
    for (const idx of picked.slice(0, PER_BATCH)) finalists.push(batch[idx]!)
  }
  const fusedRank = rankOf(pool)
  const reached = finalists.some((r) => want.has(r.id))
  push('cascade_reach', reached ? 1 : null)
  if (fusedRank !== null && fusedRank > BATCH) {
    deep.push({ q: q.slice(0, 48), fusedRank, batch: Math.floor(fusedRank / BATCH) + 1, reached })
  }

  const jFinal = finalists.length ? await judge(q, finalists, 10, false) : []
  const finalRank = new Map(jFinal.map((idx, i) => [finalists[idx]!.id, i + 1]))
  push('cascade', rankOf(fuse(pool, finalRank, 2)))

  process.stderr.write(`${qi + 1} `)
}
process.stderr.write('\n')

const n = golden.length
const at = (rs: (number | null)[], k: number) => rs.filter((r) => r !== null && r <= k).length
const mrr = (rs: (number | null)[]) => rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n

console.log(`\nСудья ${RR_MODEL} над union base+kw+hydeQ@${DEPTH}, n=${n}\n`)
console.log('вариант            @1    @5   @10    MRR')
for (const name of ['pool', 'window30', 'cascade']) {
  const rs = results[name]!
  console.log(
    `${name.padEnd(16)} ${String(at(rs, 1)).padStart(4)} ${String(at(rs, 5)).padStart(5)} ` +
      `${String(at(rs, 10)).padStart(5)}  ${mrr(rs).toFixed(3)}`,
  )
}
console.log(`\nдо финального окна каскада ответ дожил в ${results.cascade_reach!.filter(Boolean).length}/${n} запросах`)
console.log(`(в union доступно 53, в топ-30 слияния — 40)`)
console.log('\nОтветы за пределами первого батча — спас ли их каскад:')
for (const d of deep) {
  console.log(`  ранг ${String(d.fusedRank).padStart(3)} (батч ${d.batch})  ${d.reached ? 'СПАСЁН' : 'потерян'}   ${d.q}`)
}
console.log(`\nспасено ${deep.filter((d) => d.reached).length} из ${deep.length}`)
await closeDb()
