/** Сколько ответов теряется между union и окном судьи (топ-30 слияния). */
import { readFileSync } from 'node:fs'
const BR = ['base','kw','hydeQ','hydeD','lex'] as const
type B = (typeof BR)[number]
interface PQ { lists: Record<B,string[]>; hit: Record<B,number|null>; matches: string[] }
const data: PQ[] = JSON.parse(readFileSync('scratch/out/qx-lists-v2.json','utf8'))
if (data.length !== golden.length) {
  // Кэш и набор сопоставляются по индексу, поэтому расхождение длин означает
  // молча перепутанные запросы, а не мелкое неудобство.
  throw new Error(
    `кэш списков не соответствует набору: data ${data.length} против golden ${golden.length}. ` +
      'Удалите scratch/out/qx-lists-v2.json и пересоберите.',
  )
}
const core: B[] = ['base','kw','hydeQ']
const D = 55

const fused = (q: PQ, subset: B[], d: number, k = 60) => {
  const s = new Map<string, number>()
  for (const b of subset) q.lists[b].slice(0, d).forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1/(k+i+1)))
  return [...s.entries()].sort((a,b)=>b[1]-a[1]).map(([id])=>id)
}
const rankIn = (ids: string[], want: Set<string>) => { const i = ids.findIndex(x=>want.has(x)); return i<0?null:i+1 }

const inUnion = data.filter((q) => core.some(b => q.hit[b]!==null && q.hit[b]!<=D)).length
const ranks = data.map((q) => rankIn(fused(q, core, D), new Set(q.matches)))
const at = (k:number)=>ranks.filter(r=>r!==null&&r<=k).length

console.log(`union base+kw+hydeQ @${D}: доступно ${inUnion}/${data.length}`)
console.log(`из них в слиянии:  топ-10 ${at(10)}   топ-20 ${at(20)}   топ-30 ${at(30)}   топ-50 ${at(50)}   весь union ${at(1000)}`)
console.log(`\nПотеря между union и окном судьи в 30 карточек: ${inUnion - at(30)} ответов`)
console.log('Их ранги в слиянии:', ranks.map((r,i)=>({r,i})).filter(x=>x.r!==null&&x.r>30).map(x=>x.r).sort((a,b)=>a!-b!).join(', '))
