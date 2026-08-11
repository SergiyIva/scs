import { mkdirSync } from 'node:fs'

/**
 * Каталог кэшей замеров. Скрипты лежат в git, а кэши нет, поэтому на свежем
 * клоне каталога не существует и первый writeFileSync падал бы посреди прогона.
 */
export const OUT = 'scratch/out'
mkdirSync(OUT, { recursive: true })
