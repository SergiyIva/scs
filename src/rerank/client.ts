import { loadConfig } from '../config.js'

/**
 * Клиент cross-encoder реранкера. Единственное место, где ядро знает о его
 * существовании; сам инструмент живёт за HTTP-контрактом (services/rerank-onnx).
 *
 * Отказ реранкера НЕ должен ронять поиск. Порядок без него хуже, но выдача
 * остаётся осмысленной, а поиск — единственный способ агента вообще что-то
 * найти. Поэтому ошибка логируется в stderr и возвращается null: вызывающий
 * код продолжает с исходным порядком.
 */
export class Reranker {
  constructor(
    private readonly url = loadConfig().search.rerank.url,
    private readonly timeoutMs = loadConfig().search.rerank.timeoutMs,
  ) {}

  /**
   * Кто на самом деле обслуживает запросы, либо null если сервис недоступен.
   *
   * Нужно приёмке: отпечаток, в котором стоит URL реранкера, но сам реранкер
   * не отвечает, аттестует систему БЕЗ второй ступени и не сообщает об этом.
   * Молчаливая деградация в отчёте о приёмке — худший вид молчаливой деградации.
   */
  async health(): Promise<{ model: string; device: string; dtype: string } | null> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null

      // Ответ проверяется по полям, а не приводится типом: сервис, вернувший
      // 200 и пустой объект, иначе прошёл бы проверку приёмки, а в отпечаток
      // уехало бы «undefined (undefined, undefined)».
      const data: unknown = await res.json()
      if (typeof data !== 'object' || data === null) return null
      const { model, device, dtype } = data as Record<string, unknown>
      if (typeof model !== 'string' || typeof device !== 'string' || typeof dtype !== 'string') {
        return null
      }
      return { model, device, dtype }
    } catch {
      return null
    }
  }

  /** Скоры в диапазоне (0,1) в порядке документов, либо null при недоступности. */
  async score(query: string, documents: string[]): Promise<number[] | null> {
    if (!documents.length) return []

    try {
      const res = await fetch(`${this.url}/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, documents }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)

      const data = (await res.json()) as { scores: number[] }
      if (data.scores.length !== documents.length) {
        throw new Error(`получено ${data.scores.length} скоров на ${documents.length} документов`)
      }
      return data.scores
    } catch (err) {
      console.error(
        `[scs] реранкер недоступен (${this.url}), выдача остаётся в порядке эмбеддера: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }
}
