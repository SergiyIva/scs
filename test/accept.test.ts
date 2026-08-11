import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wilsonLower, formatAcceptance, FROZEN_THRESHOLDS, type AcceptResult } from '../src/eval/accept.js'
import { indexProblems, formatHealth, type IndexHealth } from '../src/store/doctor.js'
import { loadGolden } from '../src/eval/run.js'

/**
 * Приёмка и доктор проверяются тестами по той же причине, по которой они вообще
 * существуют: инструмент, который молча пропускает провал, хуже отсутствующего.
 * Здесь проверяется не качество поиска, а то, что механика приёмки работает.
 */

const health = (over: Partial<IndexHealth> = {}): IndexHealth => ({
  overlap: 0.95,
  worst: { query: 'q', overlap: 0.4 },
  lostAnswers: 0,
  queries: 58,
  indexBytes: 244 * 1024 * 1024,
  vectorBytes: 183 * 1024 * 1024,
  vectors: 62_000,
  activeVectors: 62_000,
  efSearch: 200,
  ...over,
})

test('доктор молчит на здоровом индексе и находит каждый вид деградации', () => {
  assert.deepEqual(indexProblems(health()), [], 'ложная тревога на здоровом индексе')

  // Числа взяты из настоящей деградации (RECALL85 §3.0), а не выдуманы.
  assert.equal(indexProblems(health({ overlap: 0.885 })).length, 1, 'падение пересечения не замечено')
  assert.equal(
    indexProblems(health({ worst: { query: 'apple pay', overlap: 0 } })).length,
    1,
    'потеря целого кластера не замечена',
  )
  assert.equal(indexProblems(health({ lostAnswers: 1 })).length, 1, 'потерянный ответ не замечен')
  assert.equal(
    indexProblems(health({ indexBytes: 571 * 1024 * 1024 })).length,
    1,
    'раздувание индекса не замечено',
  )
})

/**
 * На здоровом индексе худший запрос давал 32%. Порог в 50% поднимал бы тревогу
 * на исправной системе, а доктор, кричащий волки, перестаёт работать.
 */
test('порог по худшему запросу откалиброван по здоровому индексу', () => {
  assert.deepEqual(indexProblems(health({ worst: { query: 'q', overlap: 0.32 } })), [])
})

test('доктор предлагает лечение, а не только диагноз', () => {
  const text = formatHealth(health({ overlap: 0.7 }))
  assert.match(text, /ПРОБЛЕМЫ/)
  assert.match(text, /DROP INDEX/, 'нет команды пересборки')
  assert.match(text, /VACUUM/)
})

test('интервал Уилсона считается и на краях', () => {
  assert.equal(wilsonLower(0, 0), 0)
  assert.ok(wilsonLower(0, 100) === 0, 'нулевые попадания дают нулевую границу')
  // 43 из 100 — ровно тот случай, ради которого выбран порог 33%.
  assert.ok(wilsonLower(43, 100) >= 0.33, `43/100 должно проходить, получено ${wilsonLower(43, 100)}`)
  assert.ok(wilsonLower(42, 100) < 0.33, '42/100 не должно проходить')
  assert.ok(wilsonLower(100, 100) > 0.95, 'полное попадание даёт высокую границу')
})

const result = (over: Partial<AcceptResult> = {}): AcceptResult => ({
  queries: 100,
  recallAt1: 0.3,
  recallAt5: 0.5,
  recallAt10: 0.55,
  recallAt50: 0.8,
  wilsonLowerAt5: 0.4,
  missingAt50: 0.2,
  mrr: 0.38,
  p50ms: 400,
  p95ms: 700,
  fingerprint: { коммит: 'abc1234', набор: 'holdout sha256:deadbeef' },
  failures: [],
  ...over,
})

test('в отчёте приёмки есть отпечаток конфигурации', () => {
  const text = formatAcceptance(result(), FROZEN_THRESHOLDS)
  assert.match(text, /коммит/, 'нет коммита — результат нельзя воспроизвести')
  assert.match(text, /sha256/, 'нет хэша набора')
})

test('провал приёмки виден в отчёте и запрещает подкрутку порогов', () => {
  const text = formatAcceptance(result({ failures: ['recall@5 ниже порога'] }), FROZEN_THRESHOLDS)
  assert.match(text, /НЕ ПРОЙДЕНА/)
  assert.match(text, /Пороги менять нельзя/)
})

/**
 * Печать отложенного набора живёт в loadGolden, а не в отдельной команде:
 * прошлая версия проверяла только `scs eval`, и `scs depth --golden` её обходил.
 */
test('отложенный набор не открывается без явного разрешения', () => {
  assert.throws(
    () => loadGolden('src/eval/holdout.unitify.jsonl'),
    /запечатан/,
    'печать не сработала',
  )
  const golden = loadGolden('src/eval/holdout.unitify.jsonl', { unseal: true })
  assert.ok(golden.length > 0, 'с --unseal набор обязан открываться')
})
