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
