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
}
