import { readFileSync } from 'node:fs'
import { search, type SearchMode } from '../store/search.js'
import type { SearchHit } from '../types.js'

/**
 * Измерение качества поиска.
 *
 * Раздел, который обычно пропускают — и потом полгода «улучшают» поиск наугад.
 * Без этих чисел невозможно ответить, помогает ли изменение чанкера, префикса
 * или весов, или только кажется, что помогает.
 */

export interface GoldenEntry {
  q: string
  /** 'path::symbol' либо просто 'path'. Достаточно попасть в любой из вариантов. */
  expect: string[]
}

export interface ModeResult {
  mode: SearchMode
  recallAt1: number
  recallAt5: number
  recallAt10: number
  mrr: number
  p50ms: number
  p95ms: number
  misses: { q: string; expect: string[]; got: string[] }[]
}

/**
 * Отложенный набор запечатан на уровне загрузки, а не отдельной команды.
 *
 * Первая версия проверяла печать только в `scs eval`, и `scs depth --golden
 * ...holdout...` её обходил. Защита, которую можно обойти соседней командой,
 * защитой не является: набор открывается один раз, после заморозки, и любой
 * прогон «просто посмотреть» превращает его в настроечный.
 */
export function loadGolden(path: string, opts: { unseal?: boolean } = {}): GoldenEntry[] {
  if (/holdout/i.test(path) && !opts.unseal) {
    throw new Error(
      `${path} — отложенный набор, он запечатан.\n` +
        `Открывается один раз, после заморозки чанк-схемы и параметров, ` +
        `и с заранее объявленным порогом качества (docs/RECALL85.md §4.2).\n` +
        `Если это тот самый раз — добавьте --unseal.`,
    )
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('//'))
    .map((l, i) => {
      try {
        return JSON.parse(l) as GoldenEntry
      } catch {
        throw new Error(`${path}: строка ${i + 1} не разбирается как JSON`)
      }
    })
}

function hitKey(h: SearchHit): string[] {
  const keys = [h.path]
  if (h.symbol) {
    // Слитые чанки несут несколько символов через запятую.
    for (const s of h.symbol.split(',')) keys.push(`${h.path}::${s.trim()}`)
  }
  // Класс, не влезший в maxTokens, чанкуется по методам: его имя оказывается
  // в parentChain, а не в symbol. Найти метод такого класса — значит найти класс,
  // иначе набор наказывает нас за размер файла, а не за качество поиска.
  for (const parent of h.parentChain) keys.push(`${h.path}::${parent}`)
  return keys
}

/** Позиция первого попадания (1-based) или null. */
function rankOfFirstHit(hits: SearchHit[], expect: string[]): number | null {
  const wanted = new Set(expect)
  for (const [i, h] of hits.entries()) {
    if (hitKey(h).some((k) => wanted.has(k))) return i + 1
  }
  return null
}

export async function evaluate(
  repo: string,
  golden: GoldenEntry[],
  mode: SearchMode,
  k = 10,
  rerank?: boolean,
): Promise<ModeResult> {
  let hit1 = 0
  let hit5 = 0
  let hit10 = 0
  let mrrSum = 0
  const times: number[] = []
  const misses: ModeResult['misses'] = []

  for (const entry of golden) {
    const t0 = Date.now()
    const hits = await search({ repo, query: entry.q, k, mode, maxPerFile: 99, rerank })
    times.push(Date.now() - t0)

    const rank = rankOfFirstHit(hits, entry.expect)
    if (rank !== null) {
      if (rank <= 1) hit1++
      if (rank <= 5) hit5++
      if (rank <= 10) hit10++
      mrrSum += 1 / rank
    } else {
      misses.push({
        q: entry.q,
        expect: entry.expect,
        got: hits.slice(0, 3).map((h) => `${h.path}::${h.symbol ?? h.kind}`),
      })
    }
  }

  const n = golden.length || 1
  times.sort((a, b) => a - b)

  return {
    mode,
    recallAt1: hit1 / n,
    recallAt5: hit5 / n,
    recallAt10: hit10 / n,
    mrr: mrrSum / n,
    p50ms: times[Math.floor(times.length * 0.5)] ?? 0,
    p95ms: times[Math.floor(times.length * 0.95)] ?? 0,
    misses,
  }
}

export function formatResults(results: ModeResult[], total: number): string {
  const out: string[] = []
  out.push(`Запросов в наборе: ${total}\n`)
  out.push('режим      recall@1  recall@5  recall@10     MRR   p50    p95')

  for (const r of results) {
    out.push(
      [
        r.mode.padEnd(9),
        pct(r.recallAt1).padStart(8),
        pct(r.recallAt5).padStart(10),
        pct(r.recallAt10).padStart(11),
        r.mrr.toFixed(3).padStart(8),
        `${r.p50ms}мс`.padStart(9),
        `${r.p95ms}мс`.padStart(9),
      ].join(''),
    )
  }

  // Если лексика ничего не нашла, гибрид вырождается в чистый вектор, и
  // одинаковые числа в двух строках — не совпадение, а отсутствие сигнала.
  const lex = results.find((r) => r.mode === 'lexical')
  if (lex && lex.recallAt10 < 0.2) {
    out.push(
      `\nЛексическая ветка нашла ${pct(lex.recallAt10)} — на этом наборе её вклад ` +
        `оценить нельзя. Добавьте запросы с именами символов и на английском.`,
    )
  }

  // Промахи важнее агрегатов: именно из них видно, что чинить дальше.
  const hybrid = results.find((r) => r.mode === 'hybrid')
  if (hybrid?.misses.length) {
    out.push(`\nПромахи гибрида (${hybrid.misses.length}):`)
    for (const m of hybrid.misses) {
      out.push(`  «${m.q}»`)
      out.push(`     ждали: ${m.expect.join(' | ')}`)
      out.push(`     дали:  ${m.got.join(' | ') || '(пусто)'}`)
    }
  }

  // 85% — исследовательский ориентир, а НЕ порог выпуска: измеренного пути к нему
  // в архитектуре чистого retrieval нет (docs/RECALL85.md §4.2). Порог качества
  // задаётся отдельно и заранее, до открытия отложенного набора.
  const REFERENCE = 0.85
  if (hybrid && hybrid.recallAt5 < REFERENCE) {
    out.push(
      `\nRecall@5 = ${pct(hybrid.recallAt5)} при ориентире ${pct(REFERENCE)}. ` +
        `Смотрите промахи выше, а не общий процент.`,
    )
  }
  return out.join('\n')
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}
