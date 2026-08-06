import { readFileSync } from 'node:fs'
import { search } from '../store/search.js'

/**
 * Коэффициент схлопывания: сколько вызовов инструментов заменяет один search_code.
 *
 * Зачем это отдельная метрика. Телеметрия роя (§16) показала главное: время
 * съедают не сами инструменты (все детерминированные команды заняли 6–8 минут
 * из 86), а ходы модели — каждый вызов стоит одного хода. Значит ценность
 * поиска не в скорости, а в СОКРАЩЕНИИ ЧИСЛА вызовов. Оценка «примерно
 * половина цепочек схлопнётся» была допущением; здесь она заменяется замером.
 *
 * Методика: берём реальные цепочки разведки из транскриптов (grep → grep →
 * grep → Read), каждая с известным ответом — файлом, который агент в итоге
 * открыл. Задаём один семантический запрос вместо всей цепочки и смотрим,
 * попал ли этот файл в выдачу.
 */

export interface Chain {
  intent: string
  calls: number
  queries: string[]
  answer: string
  symbol?: string
  transcript?: string
}

export interface CollapseResult {
  chains: number
  /** Цепочек, где один search_code вернул нужный файл в топ-k. */
  collapsed: number
  /** Вызовов в исходных цепочках. */
  callsBefore: number
  /** Вызовов после замены: 1 на схлопнувшуюся цепочку, исходные — на остальные. */
  callsAfter: number
  misses: { intent: string; answer: string; got: string[] }[]
}

export function loadChains(path: string): Chain[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('//'))
    .map((l, i) => {
      try {
        return JSON.parse(l) as Chain
      } catch {
        throw new Error(`${path}: строка ${i + 1} не разбирается как JSON`)
      }
    })
}

export async function measureCollapse(
  repo: string,
  chains: Chain[],
  k = 5,
): Promise<CollapseResult> {
  const result: CollapseResult = {
    chains: chains.length,
    collapsed: 0,
    callsBefore: 0,
    callsAfter: 0,
    misses: [],
  }

  for (const chain of chains) {
    result.callsBefore += chain.calls

    const hits = await search({ repo, query: chain.intent, k })
    const found = hits.some((h) => h.path === chain.answer)

    if (found) {
      result.collapsed++
      // Один вызов search_code вместо всей цепочки. Плюс, честно говоря,
      // ещё один Read — но его агент делал и в старом сценарии, поэтому
      // он есть в обеих частях и на разницу не влияет.
      result.callsAfter += 1
    } else {
      // Не нашли — цепочка остаётся как была, и мы ещё потратили лишний вызов
      // на неудачный поиск. Считаем это честно, а не «в худшем случае как было».
      result.callsAfter += chain.calls + 1
      result.misses.push({
        intent: chain.intent,
        answer: chain.answer,
        got: hits.slice(0, 3).map((h) => h.path),
      })
    }
  }

  return result
}

export function formatCollapse(r: CollapseResult, k: number): string {
  const rate = r.chains ? (r.collapsed / r.chains) * 100 : 0
  const saved = r.callsBefore - r.callsAfter
  const savedPct = r.callsBefore ? (saved / r.callsBefore) * 100 : 0

  const out = [
    `Цепочек разведки из транскриптов: ${r.chains}`,
    `Схлопнулось в один search_code (ответ в топ-${k}): ${r.collapsed} (${rate.toFixed(1)}%)`,
    '',
    `Вызовов инструментов было:  ${r.callsBefore}`,
    `Вызовов стало:              ${r.callsAfter}`,
    `Экономия:                   ${saved} вызовов (${savedPct.toFixed(1)}%)`,
    '',
    'Каждый вызов инструмента — это ход модели, а ходы и есть время работы роя (§16).',
  ]

  if (r.misses.length) {
    out.push('', `Не схлопнулись (${r.misses.length}):`)
    for (const m of r.misses) {
      out.push(`  «${m.intent}»`)
      out.push(`     ждали: ${m.answer}`)
      out.push(`     дали:  ${m.got.join(' | ') || '(пусто)'}`)
    }
  }
  return out.join('\n')
}
