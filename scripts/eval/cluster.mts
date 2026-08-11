/**
 * Насколько выдача склеена по файлам.
 *
 * Нужно для эксперимента A: модульный JSDoc одинаков у всех чанков файла,
 * и есть риск, что они превратятся в плотный кластер и вытеснят из топа
 * всё остальное. Ровно этот эффект уже ловили с пропорциональным заголовком
 * (DESIGN §15): общие строки на коротком чанке начинают описывать файл,
 * а не функцию.
 *
 * Диверсификация (максимум 2 чанка на файл) этот эффект маскирует, поэтому
 * меряем с maxPerFile = 99, то есть до неё.
 */
import { search } from '../../src/store/search.js'
import { loadGolden } from '../../src/eval/run.js'
import { closeDb } from '../../src/store/pool.js'

const REPO = process.env.SCS_REPO ?? 'unitify'
const K = 20
const golden = loadGolden(process.env.GOLDEN ?? 'src/eval/golden.unitify.jsonl')

let distinctSum = 0
let maxSameSum = 0
const worst: { q: string; sameFile: number; path: string }[] = []

for (const entry of golden) {
  const hits = await search({ repo: REPO, query: entry.q, k: K, maxPerFile: 99, rerank: false })
  const byFile = new Map<string, number>()
  for (const h of hits) byFile.set(h.path, (byFile.get(h.path) ?? 0) + 1)

  const distinct = byFile.size
  const [path, maxSame] = [...byFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  distinctSum += distinct
  maxSameSum += maxSame
  if (maxSame >= 6) worst.push({ q: entry.q.slice(0, 50), sameFile: maxSame, path })
  process.stderr.write('.')
}
process.stderr.write('\n')

const n = golden.length
console.log(`\nСостав топ-${K} до диверсификации, ${n} запросов:`)
console.log(`  различных файлов в среднем: ${(distinctSum / n).toFixed(1)} из ${K}`)
console.log(`  чанков из одного файла, в среднем максимум: ${(maxSameSum / n).toFixed(1)}`)
console.log(`  запросов, где один файл занял 6+ мест: ${worst.length}`)
for (const w of worst.slice(0, 8)) {
  console.log(`    ${String(w.sameFile).padStart(2)} мест  ${w.path.slice(-58)}  «${w.q}»`)
}
await closeDb()
