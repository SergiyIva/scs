/**
 * Каскад, который не разрушает верхушку.
 *
 * Замер stage2b: батч-судья спасает 9 из 13 глубоких ответов, но общий охват
 * не растёт — значит ровно столько же он выбрасывает из первого батча, где
 * ответ уже стоял. Причина в том, что квота «до 8 из батча» применяется и
 * к голове списка: судья ошибается, и сильный кандидат исчезает.
 *
 * Здесь голова проходит БЕЗ фильтра, а судья работает только на повышение:
 * он может достать кандидата из глубины, но не может выкинуть верхний.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { db, closeDb } from '../src/store/pool.js'
import { loadGolden } from '../src/eval/run.js'

const RR_MODEL = process.env.RR_MODEL ?? 'qwen3-vl:8b'
const DEPTH = 55, BATCH = 30, PER_BATCH = 8
const HEAD_KEEP = Number(process.env.HEAD_KEEP ?? 15)
const BR = ['base', 'kw', 'hydeQ'] as const

const golden = loadGolden('src/eval/golden.unitify.jsonl')
const lists: { lists: Record<string, string[]>; matches: string[] }[] = JSON.parse(
  readFileSync('scratch/out/qx-lists-v2.json', 'utf8'),
)
const CACHE = 'scratch/out/stage2b-cache.json'
const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

interface Row { id: string; path: string; symbol: string | null; kind: string; raw_text: string; embed_text: string }
const docLine = (t: string) => t.match(/^\/\/ doc: (.+)$/m)?.[1] ?? ''
const card = (r: Row, i: number) =>
  `[${i}] ${r.path} :: ${r.symbol ?? r.kind}${docLine(r.embed_text) ? `\n// ${docLine(r.embed_text)}` : ''}\n` +
  r.raw_text.split('\n').slice(0, 6).join('\n')

async function judge(q: string, cands: Row[], take: number, allowEmpty: boolean): Promise<number[]> {
  const key = createHash('sha256').update(`${RR_MODEL}::${take}::${allowEmpty}::${q}::${cands.map((c) => c.id).join(',')}`).digest('hex')
  if (cache[key]) return cache[key]
  const prompt =
    `Вопрос разработчика о JS/TS-монорепе: «${q}»\n\n` +
    `Ниже ${cands.length} фрагментов-кандидатов. Определи, какие из них реализуют то, о чём спрашивают ` +
    `(не тесты и не документацию, если есть реализация). ` +
    (allowEmpty ? `Если ни один фрагмент не отвечает на вопрос — верни пустой список: лучше пропустить, чем додумать. ` : '') +
    `Верни JSON {"ranking": [индексы до ${take} лучших, от лучшего к худшему]}.\n\n` +
    cands.map((c, i) => card(c, i)).join('\n\n')
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model: RR_MODEL, prompt, stream: false, format: 'json', options: { temperature: 0, num_predict: 200, num_ctx: 16384 } }),
  })
  const data = (await res.json()) as { response: string; thinking?: string }
  let out: number[] = []
  try {
    const p = JSON.parse(data.response || data.thinking || '') as { ranking?: unknown }
    if (Array.isArray(p.ranking)) out = [...new Set(p.ranking.map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x < cands.length)
  } catch { /* судья промолчал */ }
  cache[key] = out
  writeFileSync(CACHE, JSON.stringify(cache))
  return out
}

const fuse = (pool: Row[], picked: Map<string, number>, w: number) =>
  pool.map((r, i) => ({ r, s: 1 / (60 + i + 1) + (picked.has(r.id) ? w / (60 + picked.get(r.id)!) : 0) }))
    .sort((a, b) => b.s - a.s).map((x) => x.r)

const res: Record<string, (number | null)[]> = {}
const push = (n: string, r: number | null) => (res[n] ??= []).push(r)
let reach = 0

for (const [qi, entry] of golden.entries()) {
  const want = new Set(lists[qi]!.matches)
  const score = new Map<string, number>()
  for (const b of BR) (lists[qi]!.lists[b] ?? []).slice(0, DEPTH).forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)))
  const order = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const { rows } = await db().query<Row>(
    `SELECT l.id::text, l.path, l.symbol, l.kind, c.raw_text, c.embed_text
       FROM chunk_locations l JOIN chunks c USING (content_hash) WHERE l.id = ANY($1::bigint[])`, [order])
  const map = new Map(rows.map((r) => [r.id, r]))
  const pool = order.map((id) => map.get(id)).filter(Boolean) as Row[]
  const rankOf = (rs: Row[]) => { const i = rs.findIndex((r) => want.has(r.id)); return i < 0 ? null : i + 1 }

  // Голова проходит без фильтра; судья работает только на повышение из глубины.
  const finalists: Row[] = [...pool.slice(0, HEAD_KEEP)]
  const seen = new Set(finalists.map((r) => r.id))
  for (let s = BATCH; s < pool.length; s += BATCH) {
    const batch = pool.slice(s, s + BATCH)
    for (const idx of (await judge(entry.q, batch, PER_BATCH, true)).slice(0, PER_BATCH)) {
      const r = batch[idx]!
      if (!seen.has(r.id)) { finalists.push(r); seen.add(r.id) }
    }
  }
  if (finalists.some((r) => want.has(r.id))) reach++

  const jf = finalists.length ? await judge(entry.q, finalists, 10, false) : []
  push('cascade2', rankOf(fuse(pool, new Map(jf.map((idx, i) => [finalists[idx]!.id, i + 1])), 2)))
  push('finalists', finalists.length)
  process.stderr.write(`${qi + 1} `)
}
process.stderr.write('\n')

const n = golden.length
const at = (rs: (number | null)[], k: number) => rs.filter((r) => r !== null && r <= k).length
const rs = res.cascade2!
console.log(`\nКаскад с неприкосновенной головой (top-${HEAD_KEEP}), ${RR_MODEL}, n=${n}`)
console.log(`@1 ${at(rs, 1)}   @5 ${at(rs, 5)}   @10 ${at(rs, 10)}   MRR ${(rs.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n).toFixed(3)}`)
console.log(`ответ дошёл до финального окна: ${reach}/${n}   финалистов в среднем ${Math.round(res.finalists!.reduce<number>((s, x) => s + (x ?? 0), 0) / n)}`)
console.log(`для сравнения: топ-30 слияния — 40/58 дошло, судья дал @5 29; каскад с фильтром головы — тоже 40 и 29`)
await closeDb()
