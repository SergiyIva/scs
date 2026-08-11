/**
 * Бюджеты размеров чанка. Вынесены в отдельный модуль, потому что их одинаково
 * используют все чанкеры, а тянуть их из chunker/index.ts значило бы завести
 * циклический импорт (index диспетчеризует по языкам и импортирует чанкеры сам).
 */
export interface ChunkBudget {
  minTokens: number
  targetTokens: number
  maxTokens: number
  headerBudget: number
  /** Строка `module:` в заголовке — назначение файла (эксперимент A). */
  moduleDocInHeader?: boolean
  /** Строка `class-doc:` в заголовке — назначение класса (эксперимент B). */
  classDocInHeader?: boolean
  /** Строки заголовка, общие для всех чанков файла (эксперимент D). */
  pathWordsInHeader?: boolean
  importsInHeader?: boolean
  exportsInHeader?: boolean
  callersInHeader?: boolean
}
