import { readFileSync } from 'node:fs'
import { loadGolden } from '../../src/eval/run.js'
const BR = ['base','kw','hydeQ','hydeD','lex'] as const
type B = (typeof BR)[number]
interface PQ { hit: Record<B, number|null> }
const data: PQ[] = JSON.parse(readFileSync('scratch/out/qx-lists-v2.json','utf8'))
const golden = loadGolden('src/eval/golden.unitify.jsonl')
if (data.length !== golden.length) {
  // Кэш и набор сопоставляются по индексу, поэтому расхождение длин означает
  // молча перепутанные запросы, а не мелкое неудобство.
  throw new Error(
    `кэш списков не соответствует набору: data ${data.length} против golden ${golden.length}. ` +
      'Удалите scratch/out/qx-lists-v2.json и пересоберите.',
  )
}

const core: B[] = ['base','kw','hydeQ']
console.log('Запросы, недоступные сокращённому union (base+kw+hydeQ) при глубине 100:')
data.forEach((q, i) => {
  const inCore = core.some((b) => q.hit[b] !== null && q.hit[b]! <= 100)
  if (inCore) return
  const r = (b: B) => q.hit[b] === null ? '—' : String(q.hit[b])
  console.log(`  «${golden[i]!.q.slice(0, 62)}»`)
  console.log(`     base ${r('base')}  kw ${r('kw')}  hydeQ ${r('hydeQ')}  |  hydeD ${r('hydeD')}  lex ${r('lex')}`)
})
const ceiling = (subset: B[], d: number) => data.filter((q) => subset.some((b) => q.hit[b] !== null && q.hit[b]! <= d)).length
console.log(`\nпотолок доступности:`)
console.log(`  base+kw+hydeQ  @55 ${ceiling(core,55)}  @100 ${ceiling(core,100)}  @300 ${ceiling(core,300)}  @1000 ${ceiling(core,1000)}`)
console.log(`  все пять       @55 ${ceiling([...BR],55)}  @100 ${ceiling([...BR],100)}  @300 ${ceiling([...BR],300)}  @1000 ${ceiling([...BR],1000)}`)
