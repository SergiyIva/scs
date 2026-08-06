import { createReadStream, createWriteStream } from 'node:fs'
import { createGzip, createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { db, tx } from './pool.js'

/**
 * Перенос посчитанных векторов между машинами.
 *
 * Работает почти бесплатно благодаря контент-адресуемости (§5):
 * `content_hash = sha256(model_id || embed_text)` одинаков на любой машине,
 * поэтому переносить нужно только таблицу `chunks`. Локации (`chunk_locations`)
 * пересобираются локальной индексацией за секунды — они дёшевы, дорог инференс.
 *
 * Практический смысл: монорепа клиента индексируется один раз, а дальше индекс
 * переезжает на любую машину без единого обращения к GPU. Приём подсмотрен
 * у Cursor, у нас он получается почти даром.
 *
 * Формат — JSONL с gzip: строковый, диффабельный, читается потоком и не требует
 * держать 54 тысячи векторов в памяти.
 */

export interface TransferStats {
  chunks: number
  bytes: number
  skipped: number
  ms: number
}

interface ExportRow {
  h: string
  e: string
  r: string
  t: number
  m: string
  v: string
}

/** Выгружает вектора одной модели (или все, если модель не указана). */
export async function exportChunks(
  path: string,
  opts: { model?: string; repo?: string } = {},
): Promise<TransferStats> {
  const started = Date.now()
  const out = createWriteStream(path)
  const gzip = createGzip()
  const done = pipeline(gzip, out)

  // Курсор, а не выборка целиком: 54 тысячи чанков — это ~400 МБ текста,
  // и держать их в памяти незачем.
  const client = await db().connect()
  let chunks = 0
  try {
    await client.query('BEGIN')
    await client.query(
      `DECLARE export_cur CURSOR FOR
         SELECT encode(c.content_hash, 'hex') AS h, c.embed_text AS e, c.raw_text AS r,
                c.token_count AS t, c.model_id AS m, c.embedding::text AS v
           FROM chunks c
          WHERE ($1::text IS NULL OR c.model_id = $1)
            AND ($2::text IS NULL OR EXISTS (
                  SELECT 1 FROM chunk_locations l JOIN repos rp ON rp.id = l.repo_id
                   WHERE l.content_hash = c.content_hash AND rp.name = $2))`,
      [opts.model ?? null, opts.repo ?? null],
    )

    for (;;) {
      const { rows } = await client.query<ExportRow>('FETCH 500 FROM export_cur')
      if (!rows.length) break
      for (const row of rows) {
        if (!gzip.write(`${JSON.stringify(row)}\n`)) {
          await new Promise((r) => gzip.once('drain', r))
        }
        chunks++
      }
    }
    await client.query('CLOSE export_cur')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  gzip.end()
  await done

  return { chunks, bytes: out.bytesWritten, skipped: 0, ms: Date.now() - started }
}

/**
 * Загружает вектора. Уже известные хэши пропускаются — импорт идемпотентен
 * и его можно повторять, докладывая дельту.
 */
export async function importChunks(path: string): Promise<TransferStats> {
  const started = Date.now()
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let chunks = 0
  let skipped = 0
  let batch: ExportRow[] = []

  const flush = async () => {
    if (!batch.length) return
    const rows = batch
    batch = []
    await tx(async (c) => {
      for (const row of rows) {
        const res = await c.query(
          `INSERT INTO chunks (content_hash, embed_text, raw_text, token_count, model_id, embedding)
           VALUES (decode($1,'hex'), $2, $3, $4, $5, $6::vector)
           ON CONFLICT (content_hash) DO NOTHING`,
          [row.h, row.e, row.r, row.t, row.m, row.v],
        )
        if (res.rowCount) chunks++
        else skipped++
      }
    })
  }

  for await (const line of rl) {
    if (!line.trim()) continue
    batch.push(JSON.parse(line) as ExportRow)
    if (batch.length >= 500) await flush()
  }
  await flush()

  return { chunks, bytes: 0, skipped, ms: Date.now() - started }
}
