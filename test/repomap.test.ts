import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRepoMap, type DirRow } from '../src/mcp/repomap.js'
import { estimateTokens } from '../src/util/tokens.js'

const dirs = (n: number, filesPerDir = 10, symbolsPerDir = 30): DirRow[] =>
  Array.from({ length: n }, (_, i) => ({
    dir: `packages/module-${String(i).padStart(3, '0')}`,
    files: filesPerDir + (i % 7),
    symbols: Array.from({ length: symbolsPerDir }, (_, s) => `exportedSymbol${i}_${s}`),
  }))

test('обзор укладывается в бюджет на монорепе из сотен каталогов', () => {
  const budget = 4000
  const out = renderRepoMap(dirs(400), budget)
  assert.ok(
    estimateTokens(out) <= budget * 1.05,
    `обзор занял ${estimateTokens(out)} токенов при бюджете ${budget}`,
  )
})

/**
 * Молча обрезанный обзор читается как «в проекте больше ничего нет» — это тот же
 * класс тихой потери, что и обрезка чанка при индексации, только на стороне выдачи.
 */
test('усечение объявляется явно и с подсказкой, как сузить область', () => {
  const out = renderRepoMap(dirs(400), 1000)
  assert.match(out, /не показано/)
  assert.match(out, /path_prefix/)
  assert.match(out, /показано \d+/)
})

test('маленький репозиторий показывается целиком и без предупреждений', () => {
  const rows = dirs(3, 5, 4)
  const out = renderRepoMap(rows, 4000)
  for (const r of rows) assert.ok(out.includes(r.dir), `${r.dir} пропал из обзора`)
  assert.doesNotMatch(out, /не показано/)
})

test('каталоги в выдаче идут по алфавиту, а отбираются по весу', () => {
  // Имя каталога намеренно не коррелирует с его размером: иначе алфавитный
  // порядок вывода и порядок отбора по весу неразличимы.
  const rows: DirRow[] = Array.from({ length: 50 }, (_, i) => ({
    dir: `dir-${String((i * 17) % 50).padStart(2, '0')}`,
    files: 50 - i,
    symbols: Array.from({ length: 20 }, (_, s) => `symbol${i}_${s}`),
  }))

  const out = renderRepoMap(rows, 600)
  const shown = rows.filter((r) => out.includes(`${r.dir}/`))
  const hidden = rows.filter((r) => !out.includes(`${r.dir}/`))

  assert.ok(hidden.length > 0, 'бюджет не сработал — нечего проверять')
  assert.ok(
    Math.min(...shown.map((r) => r.files)) >= Math.max(...hidden.map((r) => r.files)),
    'выброшен каталог крупнее показанного',
  )

  const order = shown.map((r) => out.indexOf(`${r.dir}/`))
  const alphabetical = [...shown].sort((a, b) => a.dir.localeCompare(b.dir)).map((r) => out.indexOf(`${r.dir}/`))
  assert.deepEqual(order.sort((a, b) => a - b), alphabetical, 'порядок вывода не алфавитный')
})

test('длинный список символов сворачивается с указанием остатка', () => {
  const out = renderRepoMap(dirs(1, 10, 100), 4000)
  assert.match(out, /\(\+\d+\)/, 'нет пометки о свёрнутых символах')
})

test('пустой индекс не притворяется пустым репозиторием', () => {
  assert.match(renderRepoMap([], 4000), /Индекс пуст/)
})
