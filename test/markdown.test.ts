import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkFile } from '../src/chunker/index.js'

const budget = { minTokens: 40, targetTokens: 300, maxTokens: 700, headerBudget: 120 }
const chunk = (path: string, src: string) => chunkFile('t', path, src, 'sha', budget).chunks

const DOC = `---
title: Оплата подписки
description: Как устроен биллинг и что происходит при неудачном списании
---

Этот документ описывает жизненный цикл платежа от создания до закрытия.
Он нужен всем, кто трогает биллинг: интеграция с провайдером тут не тривиальная,
а ошибки видно только в проде через сутки.

## Создание платежа

Платёж создаётся при подтверждении заказа. До подтверждения существует только
черновик, который чистится ночным джобом через двадцать четыре часа.

### Идемпотентность

Ключ идемпотентности — это идентификатор заказа. Повторный запрос с тем же
ключом возвращает уже созданный платёж, а не создаёт второй.

## Повторные списания

Если провайдер вернул временную ошибку, списание ставится в очередь на повтор
с экспоненциальной задержкой. Максимум пять попыток, потом платёж уходит
в ручной разбор к оператору поддержки.

См. также [очередь доставки](../queue/README.md) и [гейтвей](./gateway.md).

\`\`\`bash
# Это не заголовок, а комментарий в примере команды
curl -X POST /payments/retry
\`\`\`

## Отмена
`

test('секции режутся по заголовкам, а цепочка заголовков идёт в scope', () => {
  const chunks = chunk('docs/billing.md', DOC)
  const idem = chunks.find((c) => c.symbol === 'Идемпотентность')

  assert.ok(idem, 'секция третьего уровня не найдена')
  assert.deepEqual(idem.parentChain, ['Создание платежа'])
  assert.equal(idem.kind, 'section')
  assert.match(idem.embedText, /scope: section Создание платежа > Идемпотентность/)
  assert.match(idem.rawText, /Ключ идемпотентности/)
  assert.doesNotMatch(idem.rawText, /Платёж создаётся/, 'секция утащила текст родителя')
})

/**
 * Комментарий `# ...` в блоке bash — самая частая ловушка markdown-чанкера:
 * без учёта ограждений документация по CLI разваливается на мусорные секции.
 */
test('решётка внутри блока кода не считается заголовком', () => {
  const symbols = chunk('docs/billing.md', DOC).map((c) => c.symbol)
  assert.ok(
    !symbols.some((s) => s?.includes('Это не заголовок')),
    `комментарий из bash стал секцией: ${symbols.join(' | ')}`,
  )
})

test('frontmatter даёт заголовок и описание документа', () => {
  const card = chunk('docs/billing.md', DOC).find((c) => c.kind === 'file_card')
  assert.ok(card, 'карточка документа не создана')
  assert.match(card.rawText, /Заголовок: Оплата подписки/)
  assert.match(card.rawText, /Описание: Как устроен биллинг/)
  assert.match(card.rawText, /Разделы: .*Повторные списания/)
})

test('относительные ссылки попадают в заголовок обогащения как соседи по графу', () => {
  const c = chunk('docs/billing.md', DOC).find((x) => x.symbol === 'Повторные списания')
  assert.ok(c)
  assert.match(c.embedText, /imports: .*queue\/README\.md/)
  assert.doesNotMatch(c.rawText, /imports:/, 'заголовок протёк в текст для человека')
})

test('ни одна строка документа не пропадает из индекса', () => {
  const indexed = chunk('docs/billing.md', DOC)
    .filter((c) => c.kind !== 'file_card')
    .map((c) => c.rawText)
    .join('\n')

  for (const probe of [
    'жизненный цикл платежа',
    'ночным джобом',
    'Ключ идемпотентности',
    'ручной разбор',
    'curl -X POST',
    '## Отмена',
  ]) {
    assert.ok(indexed.includes(probe), `«${probe}» не попал ни в один чанк`)
  }
})

test('диапазоны строк указывают на настоящие строки документа', () => {
  const lines = DOC.split('\n')
  for (const c of chunk('docs/billing.md', DOC)) {
    assert.ok(c.endLine >= c.startLine, `${c.symbol}: диапазон вывернут L${c.startLine}-${c.endLine}`)
    assert.ok(c.endLine <= lines.length, `${c.symbol}: endLine ${c.endLine} за пределами документа`)
  }

  const retry = chunk('docs/billing.md', DOC).find((c) => c.symbol === 'Повторные списания')
  assert.ok(retry)
  assert.match(
    lines.slice(retry.startLine - 1, retry.endLine).join('\n'),
    /## Повторные списания/,
    'диапазон секции не содержит её заголовка',
  )
})

test('пустой заголовок склеивается со следующей секцией, а не даёт пустой вектор', () => {
  const src = `# API

## Методы

### GET /payments

Возвращает список платежей текущего пользователя с пагинацией по курсору.
Курсор непрозрачный, разбирать его на клиенте нельзя: формат меняется.
`
  const chunks = chunk('docs/api.md', src).filter((c) => c.kind !== 'file_card')
  assert.ok(chunks.length <= 2, `${chunks.length} чанков на документ из трёх заголовков — не склеилось`)
  assert.ok(
    chunks.some((c) => c.rawText.includes('GET /payments') && c.rawText.includes('пагинацией')),
    'заголовок и его текст разъехались по разным чанкам',
  )
})

test('длинная секция режется на части по границам абзацев', () => {
  const para = 'Строка описания поведения системы в этом разделе документации.\n'
  const src = `# Большой раздел\n\n${(para + '\n').repeat(120)}`
  const parts = chunk('docs/big.md', src).filter((c) => c.kind === 'section')

  assert.ok(parts.length > 1, 'секция на 120 абзацев не была разрезана')
  assert.match(parts[1]!.rawText, /часть 2\//, 'у части нет пометки и заголовка раздела')
  for (const p of parts) assert.ok(p.endLine >= p.startLine)
})

test('mdx индексируется как markdown', () => {
  const src = `# Компонент кнопки

import { Button } from './Button'

Кнопка используется во всех формах оплаты и подписки на рассылку.

<Button variant="primary" />
`
  const chunks = chunk('docs/button.mdx', src)
  assert.ok(chunks.length > 0)
  assert.ok(chunks.some((c) => c.rawText.includes('используется во всех формах')))
})
