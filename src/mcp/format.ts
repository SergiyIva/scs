import type { SearchHit } from '../types.js'
import { estimateTokens } from '../util/tokens.js'

/**
 * Компактный текстовый вывод, а не JSON-простыня.
 *
 * Каждый лишний токен здесь — токен, отнятый у собственно работы модели.
 * Смысл всего инструмента в том, чтобы вместо чтения двадцати файлов целиком
 * модель получила пять точных фрагментов с путями.
 */

const MAX_LINES_PER_HIT = 15

function trimCode(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_LINES_PER_HIT) return text

  const head = lines.slice(0, MAX_LINES_PER_HIT - 5)
  const tail = lines.slice(-4)
  return [...head, `  … ещё ${lines.length - MAX_LINES_PER_HIT + 1} строк …`, ...tail].join('\n')
}

export function formatHits(hits: SearchHit[], tokenBudget: number): string {
  if (!hits.length) {
    return 'Ничего не найдено. Попробуйте переформулировать запрос или снять фильтры по пути и языку.'
  }

  const parts: string[] = []
  let spent = 0

  for (const [i, h] of hits.entries()) {
    const scope = [...h.parentChain, h.symbol].filter(Boolean).join(' > ')
    const relevance = h.sim === null ? h.score.toFixed(4) : h.sim.toFixed(3)
    const header =
      `${i + 1}. ${h.path}:${h.startLine}-${h.endLine}` +
      `  ·  ${h.symbol ?? h.kind}  ·  ${relevance} (${h.via})`

    const block = [header, scope ? `   ${h.kind} ${scope}` : null, trimCode(h.rawText), '']
      .filter((x) => x !== null)
      .join('\n')

    const cost = estimateTokens(block)
    if (spent + cost > tokenBudget && parts.length > 0) {
      parts.push(`… ещё ${hits.length - i} результатов не показано (бюджет ответа исчерпан)`)
      break
    }
    parts.push(block)
    spent += cost
  }

  parts.push('Полное тело фрагмента — expand_context. Точный поиск по имени символа — Grep.')
  return parts.join('\n')
}
