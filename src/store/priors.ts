import picomatch from 'picomatch'
import type { SearchHit } from '../types.js'
import type { Config } from '../config.js'

/**
 * Априорные множители к скору поиска.
 *
 * Ранжирование по одной лишь близости запроса к чанку игнорирует то, что мы
 * знаем о самих чанках заранее: тест почти никогда не является ответом на
 * вопрос «как это работает», а карточка файла — это наша собственная сводка,
 * а не код. Идея штрафов по шаблонам пути взята из grepai (search.boost.penalties).
 *
 * Множители только ПОНИЖАЮТ. Повышающих приоритетов здесь намеренно нет:
 * понижение шума безопаснее, чем угадывание, что важно, — последнее уже один
 * раз обмануло нас на приоритете по числу ссылок.
 */

export interface CompiledPriors {
  apply: (hit: SearchHit) => number
}

export function compilePriors(cfg: Config): CompiledPriors {
  const matchers = cfg.search.penalties.map((p) => ({
    match: picomatch(p.pattern, { dot: true }),
    factor: p.factor,
  }))

  return {
    apply(hit) {
      let factor = 1

      // Карточка файла отвечает на «какой модуль про X», а не на «как это сделано».
      if (hit.kind === 'file_card') factor *= cfg.search.fileCardPrior

      for (const m of matchers) {
        if (m.match(hit.path)) factor *= m.factor
      }
      return factor
    },
  }
}
