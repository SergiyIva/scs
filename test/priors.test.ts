import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compilePriors } from '../src/store/priors.js'
import type { Config } from '../src/config.js'
import type { SearchHit } from '../src/types.js'

function cfg(over: Partial<Config['search']> = {}): Config {
  return {
    search: {
      topK: 8,
      defaultMode: 'semantic',
      candidates: 50,
      rrfK: 60,
      maxPerFile: 2,
      tokenBudget: 4000,
      vectorWeight: 1,
      lexicalWeight: 0.5,
      fileCardPrior: 0.6,
      penalties: [
        { pattern: '**/*.test.*', factor: 0.4 },
        { pattern: '**/fixtures/**', factor: 0.4 },
      ],
      ...over,
    },
  } as Config
}

function hit(path: string, kind: SearchHit['kind'] = 'function'): SearchHit {
  return {
    path,
    startLine: 1,
    endLine: 5,
    symbol: 'x',
    kind,
    parentChain: [],
    lang: 'typescript',
    rawText: '',
    score: 1,
    sim: 1,
    via: 'vector',
  }
}

test('обычный исходник не штрафуется', () => {
  assert.equal(compilePriors(cfg()).apply(hit('src/store/chunks.ts')), 1)
})

test('тесты и фикстуры понижаются', () => {
  const p = compilePriors(cfg())
  assert.equal(p.apply(hit('test/chunker.test.ts')), 0.4)
  assert.equal(p.apply(hit('packages/a/src/foo.test.ts')), 0.4)
  assert.equal(p.apply(hit('src/fixtures/sample.ts')), 0.4)
})

test('карточка файла понижается по типу чанка', () => {
  assert.equal(compilePriors(cfg()).apply(hit('src/a.ts', 'file_card')), 0.6)
})

/** Множители перемножаются: карточка файла внутри теста вдвойне не ответ. */
test('приоритет по типу и штраф по пути перемножаются', () => {
  const v = compilePriors(cfg()).apply(hit('test/chunker.test.ts', 'file_card'))
  assert.ok(Math.abs(v - 0.24) < 1e-9, `ожидали 0.6*0.4=0.24, получили ${v}`)
})

test('пустой список штрафов отключает механизм', () => {
  const p = compilePriors(cfg({ penalties: [] }))
  assert.equal(p.apply(hit('test/chunker.test.ts')), 1)
})

/** Штрафы только понижают: повышающих приоритетов быть не должно. */
test('ни один приоритет не поднимает скор выше исходного', () => {
  const p = compilePriors(cfg())
  for (const path of ['src/a.ts', 'test/a.test.ts', 'src/fixtures/b.ts', 'docs/x.ts']) {
    for (const kind of ['function', 'file_card'] as const) {
      assert.ok(p.apply(hit(path, kind)) <= 1, `${path} ${kind} поднял скор`)
    }
  }
})
