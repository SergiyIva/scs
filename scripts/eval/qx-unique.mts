import { readFileSync } from 'node:fs'
const BRANCHES = ['base', 'kw', 'hydeQ', 'hydeD', 'lex'] as const
type B = (typeof BRANCHES)[number]
interface PQ { lists: Record<B, string[]>; hit: Record<B, number | null>; matches: string[] }
const data: PQ[] = JSON.parse(readFileSync('scratch/out/qx-lists-v2.json', 'utf8'))

console.log('Уникальный вклад ветви: запросов, где ТОЛЬКО она даёт ответ в топ-N\n')
console.log('ветвь      уник@50  уник@300   доступно@50')
for (const b of BRANCHES) {
  const uniq = (d: number) =>
    data.filter((q) => {
      const ok = (x: B) => q.hit[x] !== null && q.hit[x]! <= d
      return ok(b) && BRANCHES.filter((o) => o !== b).every((o) => !ok(o))
    }).length
  const avail = data.filter((q) => q.hit[b] !== null && q.hit[b]! <= 50).length
  console.log(`${b.padEnd(10)} ${String(uniq(50)).padStart(7)} ${String(uniq(300)).padStart(9)} ${String(avail).padStart(13)}`)
}

const rrf = (q: PQ, subset: B[], k = 60) => {
  const score = new Map<string, number>()
  for (const b of subset) q.lists[b].forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  const want = new Set(q.matches)
  const i = [...score.entries()].sort((a, b) => b[1] - a[1]).findIndex(([id]) => want.has(id))
  return i < 0 ? null : i + 1
}
const prod: B[] = ['base', 'kw', 'hydeD', 'lex']
const alt: B[] = ['base', 'hydeQ']
let win = 0, lose = 0, both = 0, neither = 0
for (const q of data) {
  const a = (rrf(q, alt) ?? 1e9) <= 5
  const p = (rrf(q, prod) ?? 1e9) <= 5
  if (a && p) both++; else if (a) win++; else if (p) lose++; else neither++
}
console.log(`\nbase+hydeQ против продового base+kw+hydeD+lex по топ-5:`)
console.log(`  оба нашли: ${both}   только base+hydeQ: ${win}   только продовый: ${lose}   оба мимо: ${neither}`)
const p = 2 * (1 - 0.5 ** (win + lose)) // грубая оценка: точный биномиальный ниже
let cum = 0
const n = win + lose, C = (n: number, k: number) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r }
for (let i = 0; i <= Math.min(win, lose); i++) cum += C(n, i) * 0.5 ** n
console.log(`  расхождений ${n}, двусторонний биномиальный p ≈ ${(2 * cum).toFixed(3)} — ${2 * cum < 0.05 ? 'значимо' : 'НЕ значимо на 58 запросах'}`)
