/** Качество ↔ фактический размер union при ОДНОЙ глубине усечения. */
import { readFileSync } from 'node:fs'
const BR = ['base', 'kw', 'hydeQ', 'hydeD', 'lex'] as const
type B = (typeof BR)[number]
interface PQ { lists: Record<B, string[]>; hit: Record<B, number | null>; matches: string[] }
const data: PQ[] = JSON.parse(readFileSync('scratch/out/qx-lists-v2.json', 'utf8'))

const rrfAt = (q: PQ, quota: Partial<Record<B, number>>, k = 60) => {
  const score = new Map<string, number>()
  for (const [b, d] of Object.entries(quota) as [B, number][]) {
    q.lists[b].slice(0, d).forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  }
  const want = new Set(q.matches)
  const i = [...score.entries()].sort((a, b) => b[1] - a[1]).findIndex(([id]) => want.has(id))
  return i < 0 ? null : i + 1
}
const unionSize = (q: PQ, quota: Partial<Record<B, number>>) => {
  const s = new Set<string>()
  for (const [b, d] of Object.entries(quota) as [B, number][]) for (const id of q.lists[b].slice(0, d)) s.add(id)
  return s.size
}
const avail = (q: PQ, quota: Partial<Record<B, number>>) =>
  (Object.entries(quota) as [B, number][]).some(([b, d]) => q.hit[b] !== null && q.hit[b]! <= d)

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)]!
const report = (name: string, quota: Partial<Record<B, number>>) => {
  const rr = data.map((q) => rrfAt(q, quota))
  const sizes = data.map((q) => unionSize(q, quota))
  const at = (k: number) => rr.filter((r) => r !== null && r <= k).length
  console.log(
    `${name.padEnd(34)} RRF@5 ${String(at(5)).padStart(3)}  RRF@10 ${String(at(10)).padStart(3)}  ` +
      `доступно ${String(data.filter((q) => avail(q, quota)).length).padStart(3)}  ` +
      `union среднее ${String(Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)).padStart(4)}  p95 ${String(pct(sizes, 0.95)).padStart(4)}`,
  )
}

console.log('Глубина 50 у всех ветвей:')
report('base+hydeQ', { base: 50, hydeQ: 50 })
report('base+kw+hydeD+lex (продовый)', { base: 50, kw: 50, hydeD: 50, lex: 50 })
report('base+kw+hydeQ', { base: 50, kw: 50, hydeQ: 50 })
report('все пять', { base: 50, kw: 50, hydeQ: 50, hydeD: 50, lex: 50 })

console.log('\nЕдиная глубина против асимметричной квоты (base+kw+hydeQ):')
for (const d of [50, 55, 60, 70, 100]) report(`единая ${d}`, { base: d, kw: d, hydeQ: d })
report('base 50 + kw 55 + hydeQ 50', { base: 50, kw: 55, hydeQ: 50 })

console.log('\nЛексика по глубинам (сколько запросов находит):')
for (const d of [50, 300, 1000]) {
  console.log(`  lex@${String(d).padEnd(5)} ${data.filter((q) => q.hit.lex !== null && q.hit.lex! <= d).length}`)
}

console.log('\nУникальный вклад ВНУТРИ выбранного набора base+kw+hydeQ (@50):')
for (const b of ['base', 'kw', 'hydeQ'] as B[]) {
  const others = (['base', 'kw', 'hydeQ'] as B[]).filter((o) => o !== b)
  const u = data.filter((q) => {
    const ok = (x: B) => q.hit[x] !== null && q.hit[x]! <= 50
    return ok(b) && others.every((o) => !ok(o))
  }).length
  console.log(`  ${b.padEnd(6)} ${u}`)
}

// Расхождения при глубине 50: значима ли разница base+hydeQ и продового?
let win = 0, lose = 0
for (const q of data) {
  const a = (rrfAt(q, { base: 50, hydeQ: 50 }) ?? 1e9) <= 5
  const p = (rrfAt(q, { base: 50, kw: 50, hydeD: 50, lex: 50 }) ?? 1e9) <= 5
  if (a && !p) win++; else if (p && !a) lose++
}
const C = (n: number, k: number) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r }
const n = win + lose
let cum = 0
for (let i = 0; i <= Math.min(win, lose); i++) cum += C(n, i) * 0.5 ** n
console.log(`\nПри глубине 50: только base+hydeQ ${win}, только продовый ${lose}, p ≈ ${(2 * cum).toFixed(3)}`)
