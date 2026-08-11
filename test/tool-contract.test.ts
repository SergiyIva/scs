import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { langFor as langForCode } from '../src/chunker/typescript.js'
import { langFor as langForDoc } from '../src/chunker/markdown.js'

/**
 * Описание инструмента — часть контракта, а не комментарий.
 *
 * Фильтр `lang` полгода перечислял только четыре языка кода, хотя чанкер
 * с самого начала клал в индекс `markdown` и `mdx`. Поведение было верным,
 * врало описание — а для модели, которая инструмент никогда не видела,
 * описание И ЕСТЬ поведение: отфильтровать документацию было нельзя,
 * не угадав незадокументированное значение. Обнаружилось со стороны
 * пользователя, который завёл на это отдельный свод правил.
 *
 * Поэтому список значений пиннится к тому, что реально порождает чанкер,
 * а не сверяется глазами при следующей правке.
 */

const SOURCES = ['src/mcp/server.ts', 'src/bin/scs.ts']

test('описание lang перечисляет все языки, которые порождает чанкер', async () => {
  const produced = new Set([
    ...['a.ts', 'a.mts', 'a.tsx', 'a.jsx', 'a.js'].map(langForCode),
    ...['a.md', 'a.mdx'].map(langForDoc),
  ])

  for (const file of SOURCES) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    // Берём именно строку с перечислением, а не весь файл: слово «typescript»
    // встречается в исходнике десятки раз, и поиск по всему тексту прошёл бы
    // даже с пустым describe.
    const line = src.split('\n').find((l) => l.includes('typescript |'))
    assert.ok(line, `${file}: не найдено перечисление значений lang`)

    for (const lang of produced) {
      assert.ok(line.includes(lang), `${file}: в описании lang нет «${lang}», а чанкер его выдаёт`)
    }
  }
})
