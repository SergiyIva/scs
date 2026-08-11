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
  /** Первая строка модульного JSDoc: назначение файла (эксперимент A). */
  moduleDoc?: string | null
  /** JSDoc класса для его метода (эксперимент B). */
  parentDoc?: string | null
  /** Включать ли строку path-words (эксперимент D). */
  withPathWords?: boolean
  /** Имена вызывающих символов (эксперимент C). */
  callers?: string[]
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
 *
 * Заголовок масштабируется под размер кода. Причина: строки repo/file/path-words/
 * exports/imports ОДИНАКОВЫ для всех чанков файла, и на коротком чанке они
 * составляют большую часть входа модели — вектор начинает описывать файл, а не
 * функцию. Измеренное следствие: тривиальный хелпер toVectorLiteral (47 токенов
 * кода при 78 токенах заголовка) обыгрывал missingHashes на запросе, к которому
 * не имел отношения.
 *
 * Поэтому при нехватке места строки отбрасываются от наименее специфичных для
 * чанка к наиболее: сначала exports (чистая файловая обвязка), затем imports,
 * затем path-words. repo/file/scope/doc не отбрасываются никогда — это адрес
 * чанка и его собственное описание.
 */
export function buildHeader(
  ctx: EnrichContext,
  budgetTokens: number,
  codeTokens = Number.POSITIVE_INFINITY,
): string {
  const scope = [...ctx.parentChain, ctx.symbol].filter(Boolean)

  const always = [`// repo: ${ctx.repo}`, `// file: ${ctx.path}`]
  if (scope.length) always.push(`// scope: ${ctx.kind} ${scope.join(' > ')}`)
  if (ctx.doc) always.push(`// doc: ${ctx.doc}`)

  // От наиболее ценного к наименее — отбрасываем с конца.
  //
  // Назначение класса и модуля стоит первым: разбор промахов (RECALL85 §2)
  // показал класс запросов, где связка «механизм → роль в сценарии» есть ТОЛЬКО
  // в docstring класса или файла, а сам чанк описывает лишь как это сделано.
  // Но обе строки ОДИНАКОВЫ для всех чанков файла, поэтому они в optional,
  // а не в always: на коротком чанке заголовок не должен описывать файл вместо
  // функции — этой ошибкой мы уже платили за пропорциональный заголовок (§15).
  const optional: string[] = []
  // Вызывающие идут раньше всего остального опционального: назначение
  // фрагмента часто известно не ему самому, а тому, кто его зовёт.
  if (ctx.callers?.length) optional.push(`// callers: ${ctx.callers.join(', ')}`)
  if (ctx.parentDoc) optional.push(`// class-doc: ${ctx.parentDoc}`)
  if (ctx.moduleDoc && ctx.moduleDoc !== ctx.doc) optional.push(`// module: ${ctx.moduleDoc}`)
  if (ctx.withPathWords !== false) optional.push(`// path-words: ${pathWords(ctx.path)}`)
  if (ctx.imports.length) optional.push(`// imports: ${list(ctx.imports)}`)
  if (ctx.exports.length) optional.push(`// exports: ${list(ctx.exports)}`)

  // Заголовок не должен весить больше кода, который он описывает.
  const allowance = Math.min(budgetTokens, Math.max(codeTokens, MIN_HEADER_TOKENS))

  const kept = [...optional]
  const assemble = () => [...always.slice(0, 2), ...kept, ...always.slice(2)].join('\n')

  while (kept.length > 0 && estimateTokens(assemble()) > allowance) kept.pop()

  const header = assemble()
  return estimateTokens(header) > budgetTokens ? truncateToTokens(header, budgetTokens) : header
}

/** Ниже этого порога заголовок бесполезен: адрес чанка нужен всегда. */
const MIN_HEADER_TOKENS = 70
