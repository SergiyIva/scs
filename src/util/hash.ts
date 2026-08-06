import { createHash } from 'node:crypto'

/**
 * Идентичность чанка = его текст ДЛЯ МОДЕЛИ плюс id модели.
 *
 * model_id в хэше обязателен: вектора разных моделей несравнимы, и без него
 * смена модели тихо смешала бы два несовместимых пространства в одной таблице.
 */
export function chunkHash(modelId: string, embedText: string): Buffer {
  return createHash('sha256').update(modelId).update('\0').update(embedText).digest()
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
