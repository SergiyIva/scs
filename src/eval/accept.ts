import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { search } from '../store/search.js'
import { loadConfig } from '../config.js'
import { Embedder } from '../embed/client.js'
import type { GoldenEntry } from './run.js'

/**
 * Приёмочный прогон по отложенному набору.
 *
 * Отдельная команда, а не флаг к `scs eval`, по трём причинам, каждая из которых
 * была пробелом в прошлой версии процедуры:
 *
 * 1. **Пороги проверяются кодом, а не глазами.** «Число получено на отложенном
 *    наборе» само по себе ничего не значит: при таком правиле выпуск разрешает
 *    любое число. Пороги объявлены заранее (docs/RECALL85.md §4.2) и зашиты сюда.
 * 2. **Нужен ненулевой код возврата.** Приёмка, которая при провале печатает
 *    текст и завершается успехом, в конвейере бесполезна.
 * 3. **Нужен отпечаток.** Через полгода «мы померили 47%» без коммита, конфига
 *    и модели — это не результат, а воспоминание.
 *
 * Глубина 50, а не 10: доля «ответа нет и в топ-50» — второй объявленный порог,
 * и без неё провал невозможно разложить на доступность и ранжирование.
 */

export interface AcceptThresholds {
  recallAt5: number
  wilsonLowerAt5: number
  recallAt10: number
  maxMissingAt50: number
}

/** Пороги заморожены до открытия набора. Менять их после прогона — подлог. */
export const FROZEN_THRESHOLDS: AcceptThresholds = {
  recallAt5: 0.4,
  wilsonLowerAt5: 0.33,
  recallAt10: 0.48,
  maxMissingAt50: 0.3,
}

export interface AcceptResult {
  queries: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  recallAt50: number
  wilsonLowerAt5: number
  missingAt50: number
  mrr: number
  p50ms: number
  p95ms: number
  fingerprint: Record<string, string>
  failures: string[]
}

/**
 * Нижняя граница доверительного интервала Уилсона.
 *
 * Точечная оценка на сотне запросов гуляет на ±10 п.п., и порог по одной точке
 * пропустил бы удачную выборку. Уилсон корректен и на краях диапазона, в отличие
 * от нормального приближения.
 */
export function wilsonLower(hits: number, n: number, z = 1.96): number {
  if (n === 0) return 0
  const p = hits / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (centre - spread) / d)
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '(вне git)'
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export async function runAcceptance(
  repo: string,
  golden: GoldenEntry[],
  goldenPath: string,
  thresholds: AcceptThresholds = FROZEN_THRESHOLDS,
): Promise<AcceptResult> {
  const cfg = loadConfig()
  const modelId = await new Embedder().model()

  let hit1 = 0
  let hit5 = 0
  let hit10 = 0
  let hit50 = 0
  let mrrSum = 0
  const times: number[] = []

  const keys = (h: { path: string; symbol: string | null; parentChain: string[] }) => [
    h.path,
    ...(h.symbol ? h.symbol.split(',').map((s) => `${h.path}::${s.trim()}`) : []),
    ...h.parentChain.map((p) => `${h.path}::${p}`),
  ]

  for (const entry of golden) {
    const t0 = Date.now()
    const hits = await search({ repo, query: entry.q, k: 50, maxPerFile: 99 })
    times.push(Date.now() - t0)

    const want = new Set(entry.expect)
    const rank = hits.findIndex((h) => keys(h).some((k) => want.has(k))) + 1
    if (rank > 0) {
      if (rank <= 1) hit1++
      if (rank <= 5) hit5++
      if (rank <= 10) hit10++
      hit50++
      mrrSum += 1 / rank
    }
  }

  const n = golden.length || 1
  times.sort((a, b) => a - b)

  const result: AcceptResult = {
    queries: golden.length,
    recallAt1: hit1 / n,
    recallAt5: hit5 / n,
    recallAt10: hit10 / n,
    recallAt50: hit50 / n,
    wilsonLowerAt5: wilsonLower(hit5, n),
    missingAt50: 1 - hit50 / n,
    mrr: mrrSum / n,
    p50ms: times[Math.floor(times.length * 0.5)] ?? 0,
    p95ms: times[Math.floor(times.length * 0.95)] ?? 0,
    fingerprint: {
      коммит: gitCommit(),
      набор: `${goldenPath} sha256:${sha256(readFileSync(goldenPath, 'utf8'))}`,
      эмбеддер: modelId,
      реранкер: cfg.search.rerank.enabled ? cfg.search.rerank.url : 'выключен',
      чанки: `target=${cfg.chunk.targetTokens} max=${cfg.chunk.maxTokens} module=${cfg.chunk.moduleDocInHeader} class=${cfg.chunk.classDocInHeader} callers=${cfg.chunk.callersInHeader}`,
      поиск: `ef=${cfg.search.efSearch} cand=${cfg.search.candidates} docPrior=${cfg.search.docPrior} history=${cfg.search.includeDeleted}`,
    },
    failures: [],
  }

  if (result.recallAt5 < thresholds.recallAt5) {
    result.failures.push(
      `recall@5 ${(result.recallAt5 * 100).toFixed(1)}% ниже порога ${(thresholds.recallAt5 * 100).toFixed(0)}%`,
    )
  }
  if (result.wilsonLowerAt5 < thresholds.wilsonLowerAt5) {
    result.failures.push(
      `нижняя граница Уилсона ${(result.wilsonLowerAt5 * 100).toFixed(1)}% ниже порога ` +
        `${(thresholds.wilsonLowerAt5 * 100).toFixed(0)}%`,
    )
  }
  if (result.recallAt10 < thresholds.recallAt10) {
    result.failures.push(
      `recall@10 ${(result.recallAt10 * 100).toFixed(1)}% ниже порога ${(thresholds.recallAt10 * 100).toFixed(0)}%`,
    )
  }
  if (result.missingAt50 > thresholds.maxMissingAt50) {
    result.failures.push(
      `ответа нет в топ-50 у ${(result.missingAt50 * 100).toFixed(1)}% запросов при допустимых ` +
        `${(thresholds.maxMissingAt50 * 100).toFixed(0)}%`,
    )
  }

  return result
}

export function formatAcceptance(r: AcceptResult, t: AcceptThresholds): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const out = [
    'ПРИЁМОЧНЫЙ ПРОГОН',
    '',
    'Отпечаток конфигурации:',
    ...Object.entries(r.fingerprint).map(([k, v]) => `  ${k.padEnd(10)} ${v}`),
    '',
    `Запросов: ${r.queries}`,
    `  recall@1   ${pct(r.recallAt1)}`,
    `  recall@5   ${pct(r.recallAt5)}   (порог ${pct(t.recallAt5)})`,
    `  Уилсон@5   ${pct(r.wilsonLowerAt5)}   (порог ${pct(t.wilsonLowerAt5)})`,
    `  recall@10  ${pct(r.recallAt10)}   (порог ${pct(t.recallAt10)})`,
    `  нет в топ-50 ${pct(r.missingAt50)} (порог ${pct(t.maxMissingAt50)})`,
    `  MRR        ${r.mrr.toFixed(3)}`,
    `  латентность p50 ${r.p50ms} мс, p95 ${r.p95ms} мс`,
    '',
  ]

  if (r.failures.length) {
    out.push('ПРИЁМКА НЕ ПРОЙДЕНА:')
    for (const f of r.failures) out.push(`  • ${f}`)
    out.push('')
    out.push('Пороги менять нельзя: они заморожены до открытия набора.')
    out.push('Разложите промахи на доступность (нет в топ-50) и ранжирование')
    out.push('(есть в топ-50, но не в топ-5) и возвращайтесь к провалившейся ступени.')
  } else {
    out.push('Приёмка пройдена: все четыре порога соблюдены.')
    out.push('Набор с этого момента считается настроечным — второй раз он ничего не докажет.')
  }
  return out.join('\n')
}
