import type { EmbedKind, EmbedResponse } from '../types.js'
import { loadConfig } from '../config.js'

/**
 * Клиент к эмбеддинг-сервису. Единственная точка, где TS-ядро касается инференса.
 *
 * Клиент НЕ знает про префиксы модели — он передаёт только kind. Префиксы живут
 * в сервисе, потому что они свойство модели, а не вызывающего кода.
 */

export interface EmbedStats {
  requests: number
  inputs: number
  truncated: number
  ms: number
}

export class Embedder {
  readonly stats: EmbedStats = { requests: 0, inputs: 0, truncated: 0, ms: 0 }
  private modelId: string | null = null

  constructor(
    private readonly url = loadConfig().embed.url,
    private readonly batchSize = loadConfig().embed.batchSize,
    private readonly dims = loadConfig().embed.dims,
  ) {}

  /** Идентификатор модели с сервиса — попадает в content_hash каждого чанка. */
  async model(): Promise<string> {
    if (this.modelId) return this.modelId
    const res = await fetch(`${this.url}/health`)
    if (!res.ok) throw new Error(`эмбеддер недоступен: ${this.url} вернул ${res.status}`)
    const h = (await res.json()) as { model: string; dims: number; ready: boolean }
    if (h.dims !== this.dims) {
      throw new Error(
        `эмбеддер отдаёт ${h.dims} измерений, а схема БД рассчитана на ${this.dims}. ` +
          `Смена размерности требует пересоздания таблицы chunks.`,
      )
    }
    this.modelId = h.model
    return h.model
  }

  async embed(inputs: string[], kind: EmbedKind): Promise<number[][]> {
    if (inputs.length === 0) return []

    const out: number[][] = []
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize)
      out.push(...(await this.embedBatch(batch, kind)))
    }
    return out
  }

  private async embedBatch(batch: string[], kind: EmbedKind, attempt = 0): Promise<number[][]> {
    const started = Date.now()
    try {
      const res = await fetch(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: batch, kind, dims: this.dims }),
      })
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)

      const data = (await res.json()) as EmbedResponse
      if (data.vectors.length !== batch.length) {
        throw new Error(`получено ${data.vectors.length} векторов на ${batch.length} входов`)
      }

      this.stats.requests++
      this.stats.inputs += batch.length
      this.stats.truncated += data.truncated.filter(Boolean).length
      this.stats.ms += Date.now() - started
      return data.vectors
    } catch (err) {
      // Батч мог не влезть в память ускорителя — делим пополам, прежде чем сдаваться.
      if (batch.length > 1 && attempt < 2) {
        const mid = Math.ceil(batch.length / 2)
        return [
          ...(await this.embedBatch(batch.slice(0, mid), kind, attempt + 1)),
          ...(await this.embedBatch(batch.slice(mid), kind, attempt + 1)),
        ]
      }
      throw new Error(
        `эмбеддинг не удался (${batch.length} входов): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Доля входов, упёршихся в контекст модели. Больше 5% — чанкер режет плохо. */
  truncationRate(): number {
    return this.stats.inputs === 0 ? 0 : this.stats.truncated / this.stats.inputs
  }
}
