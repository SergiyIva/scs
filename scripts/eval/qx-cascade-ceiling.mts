/** Потолок каскада: спасает ли поветвевой отбор то, что топит слияние. */
import { readFileSync } from 'node:fs'
const BR = ['base','kw','hydeQ','hydeD','lex'] as const
type B = (typeof BR)[number]
interface PQ { lists: Record<B,string[]>; hit: Record<B,number|null>; matches: string[] }
const data: PQ[] = JSON.parse(readFileSync('scratch/out/qx-lists-v2.json','utf8'))
const core: B[] = ['base','kw','hydeQ']
const D = 55

const fused = (q: PQ, d: number, k = 60) => {
  const s = new Map<string, number>()
  for (const b of core) q.lists[b].slice(0, d).forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1/(k+i+1)))
  return [...s.entries()].sort((a,b)=>b[1]-a[1]).map(([id])=>id)
}

console.log('Ответы, утонувшие в слиянии (ранг > 30) — их место ВНУТРИ ветвей:\n')
console.log('  ранг слияния   base    kw  hydeQ   спасает поветвевой отбор top-N?')
let savedBy8 = 0, savedBy10 = 0, savedBy20 = 0, lost = 0, deep = 0
for (const q of data) {
  const want = new Set(q.matches)
  const f = fused(q, D)
  const fr = f.findIndex(id => want.has(id)) + 1
  const avail = core.some(b => q.hit[b]!==null && q.hit[b]!<=D)
  if (!avail || (fr > 0 && fr <= 30)) continue
  const best = Math.min(...core.map(b => q.hit[b] ?? 1e9))
  const mark = best <= 8 ? 'да (top-8)' : best <= 10 ? 'да (top-10)' : best <= 20 ? 'только top-20' : 'нет'
  deep++
  if (best <= 8) savedBy8++
  else if (best <= 10) savedBy10++
  else if (best <= 20) savedBy20++
  else lost++
  console.log(`  ${String(fr||'—').padStart(11)}  ${String(q.hit.base ?? '—').padStart(5)} ${String(q.hit.kw ?? '—').padStart(5)} ${String(q.hit.hydeQ ?? '—').padStart(6)}   ${mark}`)
}
console.log(
  `\nиз ${deep}: спасаются квотой top-8 — ${savedBy8}, только top-10 — ${savedBy10}, ` +
    `только top-20 — ${savedBy20}, не спасаются — ${lost}`,
)

// Потолок каскада: сколько ответов доживает до финального окна при разных квотах
for (const quota of [5, 8, 10, 15]) {
  let reach = 0, size = 0
  for (const q of data) {
    const want = new Set(q.matches)
    const picked = new Set<string>()
    for (const b of core) for (const id of q.lists[b].slice(0, quota)) picked.add(id)
    size += picked.size
    if ([...picked].some(id => want.has(id))) reach++
  }
  console.log(`квота ${String(quota).padStart(2)} на ветвь → доступно ${reach}/${data.length}, финальное окно в среднем ${Math.round(size/data.length)} карточек`)
}
