import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkFile } from '../src/chunker/index.js'

const budget = { minTokens: 40, targetTokens: 300, maxTokens: 700, headerBudget: 120 }
const chunk = (path: string, src: string) => chunkFile('t', path, src, 'sha', budget).chunks

const SAMPLE = `import { queue } from './client'

const BASE = 500
const MAX = 60000

/**
 * Schedules a failed transaction for another delivery attempt.
 */
export async function scheduleRedelivery(id: string, attempt: number): Promise<void> {
  const delay = Math.min(BASE * 2 ** attempt, MAX)
  await queue.enqueue(id, delay)
}

export function nextInterval(attempt: number): number {
  return Math.min(BASE * 2 ** attempt, MAX)
}
`

/**
 * Регрессия: preamble добавлялся в конец списка кусков, хотя физически стоит
 * первым. mergeSmall склеивал его с последней функцией и присваивал ей
 * endLine от preamble — получался диапазон вида L20-7.
 */
test('диапазоны строк не вывернуты наизнанку', () => {
  const totalLines = SAMPLE.split('\n').length
  for (const c of chunk('src/backoff.ts', SAMPLE)) {
    assert.ok(c.startLine >= 1, `${c.symbol}: startLine ${c.startLine} < 1`)
    assert.ok(
      c.endLine >= c.startLine,
      `${c.symbol ?? c.kind}: диапазон вывернут L${c.startLine}-${c.endLine}`,
    )
    assert.ok(
      c.endLine <= totalLines,
      `${c.symbol ?? c.kind}: endLine ${c.endLine} за пределами файла (${totalLines})`,
    )
  }
})

test('символы находятся по своим настоящим строкам', () => {
  const lines = SAMPLE.split('\n')
  const chunks = chunk('src/backoff.ts', SAMPLE)

  const next = chunks.find((c) => c.symbol === 'nextInterval')
  assert.ok(next, 'nextInterval не найден')
  assert.match(
    lines.slice(next.startLine - 1, next.endLine).join('\n'),
    /function nextInterval/,
    'диапазон nextInterval не содержит его объявления',
  )
})

const SAMPLE_WITH_HEAD = `import { queue } from './client'
import { logger } from '../../observability/src/logger'
import type { Payment, Refund, Chargeback } from '../../payments/src/types'

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 60_000
const DEAD_LETTER_TOPIC = 'payments.dead-letter'
const RETRYABLE_STATUSES = new Set(['failed', 'timeout', 'gateway_error'])

export function nextInterval(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}
`

test('preamble идёт первым и покрывает импорты', () => {
  const chunks = chunk('src/backoff.ts', SAMPLE_WITH_HEAD)
  const preamble = chunks.find((c) => c.kind === 'preamble')
  assert.ok(preamble, 'preamble не создан')
  assert.equal(preamble.startLine, 1)
  assert.match(preamble.rawText, /import \{ queue \}/)
  assert.match(preamble.rawText, /DEAD_LETTER_TOPIC/)
  assert.doesNotMatch(preamble.rawText, /function nextInterval/, 'preamble залез в тело функции')
})

/**
 * Шапка короче minTokens отбрасывается намеренно: список импортов и так попадает
 * в обогащающий заголовок КАЖДОГО чанка файла, так что отдельный вектор на пару
 * строк импорта — чистый шум в индексе.
 */
test('короткая шапка не превращается в отдельный чанк', () => {
  const preamble = chunk('src/backoff.ts', SAMPLE).find((c) => c.kind === 'preamble')
  assert.equal(preamble, undefined, 'шапка на 22 токена не должна давать чанк')

  const anyChunk = chunk('src/backoff.ts', SAMPLE)[0]
  assert.match(anyChunk!.embedText, /imports: \.\/client/, 'импорты потерялись и из заголовка')
})

test('обогащающий заголовок есть в embedText и отсутствует в rawText', () => {
  const c = chunk('packages/queue/src/backoff.ts', SAMPLE).find(
    (x) => x.symbol === 'scheduleRedelivery',
  )
  assert.ok(c)
  assert.match(c.embedText, /path-words: packages queue src backoff/)
  assert.match(c.embedText, /doc: Schedules a failed transaction/)
  assert.doesNotMatch(c.rawText, /path-words/, 'заголовок протёк в текст для человека')
})

test('карточка файла перечисляет экспорты', () => {
  const card = chunk('src/backoff.ts', SAMPLE).find((c) => c.kind === 'file_card')
  assert.ok(card)
  assert.match(card.rawText, /scheduleRedelivery/)
  assert.match(card.rawText, /nextInterval/)
})

test('переросток режется на части, а не даёт один бессмысленный вектор', () => {
  const body = Array.from({ length: 400 }, (_, i) => `  const v${i} = compute(${i})`).join('\n')
  const huge = `export function giant(): void {\n${body}\n}\n`
  const parts = chunk('src/giant.ts', huge).filter((c) => c.symbol === 'giant')

  assert.ok(parts.length > 1, 'функция на 400 строк не была разрезана')
  for (const p of parts) assert.ok(p.endLine >= p.startLine)
  assert.match(parts[1]!.rawText, /фрагмент 2\//, 'у части нет пометки о фрагменте')
})
