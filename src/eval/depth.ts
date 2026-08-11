import { db, toVectorLiteral } from '../store/pool.js'
import { Embedder } from '../embed/client.js'
import type { GoldenEntry } from './run.js'

/**
 * Ранг правильного ответа в чистой векторной выдаче, без приоритетов
 * и диверсификации.
 *
 * Отвечает на вопрос, который агрегированный recall@5 маскирует: промах —
 * это плохой порядок или отсутствие ответа среди кандидатов вообще? Разница
 * определяет, что делать дальше. Если ответ лежит на 30-м месте, поможет
 * реранкер; если его нет и в первых трёхстах — реранкер не поможет ничем,
 * и чинить надо модель. Первый замер по этой методике (§17) показал второе.
 */

export interface DepthResult {
  model: string
  /** Доля запросов, у которых ответ попал в топ-K. Ключи — глубины. */
  recallAt: Map<number, number>
  /** Медианный ранг среди найденных. */
  medianRank: number | null
  /** Не найдено вообще в пределах depth. */
  missing: number
  total: number
  /** Доля документации в топ-10 — она конкурирует с кодом за места. */
  docShareTop10: number
}

export const DEPTHS = [1, 5, 10, 50, 300]

export async function measureDepth(
  repo: string,
  golden: GoldenEntry[],
  depth = 300,
): Promise<DepthResult> {
  const embedder = new Embedder()
  const model = await embedder.model()

  const ranks: (number | null)[] = []
  let docsInTop10 = 0

  for (const entry of golden) {
    const [v] = await embedder.embed([entry.q], 'query')
    const { rows } = await db().query<{
      path: string
      symbol: string | null
      lang: string
      parent_chain: string[]
    }>(
      `SELECT l.path, l.symbol, l.lang, l.parent_chain
         FROM chunk_locations l
         JOIN chunks c USING (content_hash)
         JOIN repos r ON r.id = l.repo_id
        WHERE r.name = $1
        ORDER BY c.embedding <=> $2::vector
        LIMIT $3`,
      [repo, toVectorLiteral(v!), depth],
    )

    const wanted = new Set(entry.expect)
    const rank = rows.findIndex(
      (r) =>
        wanted.has(r.path) ||
        (r.symbol ? r.symbol.split(',').some((s) => wanted.has(`${r.path}::${s.trim()}`)) : false) ||
        // Класс режется по методам — его имя лежит в parentChain (см. eval/run.ts).
        (r.parent_chain ?? []).some((p) => wanted.has(`${r.path}::${p}`)),
    )
    ranks.push(rank < 0 ? null : rank + 1)
    docsInTop10 += rows.slice(0, 10).filter((r) => r.lang === 'markdown' || r.lang === 'mdx').length
  }

  const found = ranks.filter((r): r is number => r !== null).sort((a, b) => a - b)
  return {
    model,
    recallAt: new Map(
      DEPTHS.map((k) => [k, ranks.filter((r) => r !== null && r <= k).length / (ranks.length || 1)]),
    ),
    medianRank: found.length ? found[Math.floor(found.length / 2)]! : null,
    missing: ranks.filter((r) => r === null).length,
    total: ranks.length,
    docShareTop10: docsInTop10 / (ranks.length * 10 || 1),
  }
}

export function formatDepth(results: DepthResult[], depth = 300): string {
  const out: string[] = []
  out.push('Ранг ожидаемого ответа в чистой векторной выдаче:\n')
  out.push(`модель${' '.repeat(38)}${DEPTHS.map((k) => `@${k}`.padStart(8)).join('')}   медиана  нет в ${depth}`)

  for (const r of results) {
    out.push(
      [
        r.model.slice(0, 42).padEnd(44),
        ...DEPTHS.map((k) => `${((r.recallAt.get(k) ?? 0) * 100).toFixed(1)}%`.padStart(8)),
        String(r.medianRank ?? '—').padStart(10),
        `${r.missing}/${r.total}`.padStart(9),
      ].join(''),
    )
  }

  out.push('')
  for (const r of results) {
    out.push(`${r.model.slice(0, 42).padEnd(44)} документации в топ-10: ${(r.docShareTop10 * 100).toFixed(1)}%`)
  }

  // Различить два диагноза может только этот разрыв, поэтому он выносится явно.
  const best = results[0]
  if (best) {
    const at5 = best.recallAt.get(5) ?? 0
    const at50 = best.recallAt.get(50) ?? 0
    const deep = best.recallAt.get(300) ?? 0
    out.push('')
    out.push(
      `Запас для реранкера (между @5 и @50): ${((at50 - at5) * 100).toFixed(1)} п.п.  ` +
        `Потолок полноты (@${depth}): ${(deep * 100).toFixed(1)}% — выше него не поднимет ничто, кроме модели.`,
    )
  }
  return out.join('\n')
}
