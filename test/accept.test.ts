import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wilsonLower, formatAcceptance, FROZEN_THRESHOLDS, type AcceptResult } from '../src/eval/accept.js'
import { indexProblems, formatHealth, type IndexHealth } from '../src/store/doctor.js'
import { loadGolden } from '../src/eval/run.js'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  mrrAt10: 0.38,
  mrrAt50: 0.4,
  p50ms: 400,
  p95ms: 700,
  fingerprint: {
    коммит: '6c4bce1f0000000000000000000000000000abcd',
    набор: 'holdout sha256:ca04fd800e15f65601199293dcbc6662ef26d517b36d5adc7d2aeeeee938cac0',
  },
  failures: [],
  ...over,
})

/**
 * Граница порога проверяется тестом, а не доверием к арифметике: порог
 * перекалиброван по данным (верхняя граница Уилсона для 18/58 = 43.8%,
 * округлено до 45%), и именно на границе ошибка была бы незаметна.
 */
test('порог missing@50 держит границу 45 из 100', () => {
  const check = (missing: number) =>
    FROZEN_THRESHOLDS.maxMissingAt50 >= missing / 100

  assert.ok(check(45), '45 промахов из 100 должны проходить')
  assert.ok(!check(46), '46 промахов из 100 должны проваливать приёмку')
  // Настроечный набор: 18 из 58 = 31.0% — запас есть, но не безграничный.
  assert.ok(check(31), 'настроечное значение обязано проходить собственный порог')
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
  // Фикстура, а не настоящий набор: даже чтение боевого holdout из теста —
  // лишний повод усомниться в его чистоте, а стоит это ничего.
  const fixture = join(tmpdir(), `scs-holdout-fixture-${process.pid}.jsonl`)
  writeFileSync(fixture, '{"q":"проверка печати","expect":["a.ts::b"]}\n')
  try {
    assert.throws(() => loadGolden(fixture), /запечатан/, 'печать не сработала')
    assert.equal(loadGolden(fixture, { unseal: true }).length, 1, 'с --unseal набор обязан открываться')

    // Печать срабатывает по имени файла, а не по конкретному пути.
    const other = join(tmpdir(), `scs-golden-${process.pid}.jsonl`)
    writeFileSync(other, '{"q":"обычный набор","expect":["a.ts::b"]}\n')
    assert.equal(loadGolden(other).length, 1, 'обычный набор не должен требовать --unseal')
    rmSync(other)
  } finally {
    rmSync(fixture, { force: true })
  }
})
