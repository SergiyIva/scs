import { estimateTokens, truncateToTokens } from '../util/tokens.js'

export interface EnrichContext {
  repo: string
  path: string
  /** Экспортируемые символы файла — для карточки файла и для контекста чанка. */
  exports: string[]
  /** Модули, которые импортирует файл. */
  imports: string[]
  /** Цепочка родителей: ['RedeliveryQueue'] для метода класса. */
  parentChain: string[]
  symbol: string | null
  kind: string
  /** Первая строка JSDoc. */
  doc: string | null
}

/**
 * Разворачивает путь в слова: 'packages/queue/src/backoff.ts'
 *   -> 'packages queue src backoff'
 *
 * Это несёт непропорционально много пользы. Запрос «payment retry» цепляется
 * за src/lib/queue/backoff.ts именно через названия каталогов, даже когда
 * в теле функции слов payment и retry нет вовсе.
 */
export function pathWords(path: string): string {
  return path
    .replace(/\.[a-z]+$/i, '')
    .split(/[/\\._\-]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/))
    .filter((w) => w.length > 1)
    .join(' ')
}

const MAX_LIST = 12

function list(items: string[]): string {
  if (items.length <= MAX_LIST) return items.join(', ')
  return `${items.slice(0, MAX_LIST).join(', ')} (+${items.length - MAX_LIST})`
}

/**
 * Собирает обогащающий заголовок. Он попадает в embed_text (то, что видит модель),
 * но НЕ в raw_text (то, что показываем человеку).
 */
export function buildHeader(ctx: EnrichContext, budgetTokens: number): string {
  const lines = [`// repo: ${ctx.repo}`, `// file: ${ctx.path}`, `// path-words: ${pathWords(ctx.path)}`]

  if (ctx.exports.length) lines.push(`// exports: ${list(ctx.exports)}`)
  if (ctx.imports.length) lines.push(`// imports: ${list(ctx.imports)}`)

  const scope = [...ctx.parentChain, ctx.symbol].filter(Boolean)
  if (scope.length) lines.push(`// scope: ${ctx.kind} ${scope.join(' > ')}`)

  if (ctx.doc) lines.push(`// doc: ${ctx.doc}`)

  const header = lines.join('\n')
  return estimateTokens(header) > budgetTokens ? truncateToTokens(header, budgetTokens) : header
}
