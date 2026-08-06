import type pg from 'pg'
import type { FileChunks } from '../types.js'
import { db, tx, toVectorLiteral } from './pool.js'
import { chunkHash } from '../util/hash.js'

export interface PreparedChunk {
  hash: Buffer
  embedText: string
  rawText: string
  tokenCount: number
  startLine: number
  endLine: number
  symbol: string | null
  kind: string
  parentChain: string[]
  exported: boolean
}

export function prepare(file: FileChunks, modelId: string): PreparedChunk[] {
  return file.chunks.map((c) => ({
    hash: chunkHash(modelId, c.embedText),
    embedText: c.embedText,
    rawText: c.rawText,
    tokenCount: c.tokenCount,
    startLine: c.startLine,
    endLine: c.endLine,
    symbol: c.symbol,
    kind: c.kind,
    parentChain: c.parentChain,
    exported: c.exported,
  }))
}

/**
 * Ядро инкрементальности: возвращает только те хэши, для которых вектора ещё нет.
 * После checkout другой ветки подавляющее большинство чанков уже посчитано,
 * и эмбеддится лишь реальная дельта.
 */
export async function missingHashes(hashes: Buffer[]): Promise<Set<string>> {
  if (!hashes.length) return new Set()
  const { rows } = await db().query<{ content_hash: Buffer }>(
    'SELECT content_hash FROM chunks WHERE content_hash = ANY($1::bytea[])',
    [hashes],
  )
  const known = new Set(rows.map((r) => r.content_hash.toString('hex')))
  return new Set(hashes.map((h) => h.toString('hex')).filter((h) => !known.has(h)))
}

export async function insertChunks(
  client: pg.PoolClient,
  chunks: PreparedChunk[],
  vectors: Map<string, number[]>,
  modelId: string,
): Promise<void> {
  for (const c of chunks) {
    const vec = vectors.get(c.hash.toString('hex'))
    if (!vec) continue // уже был в базе
    await client.query(
      `INSERT INTO chunks (content_hash, embed_text, raw_text, token_count, model_id, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       ON CONFLICT (content_hash) DO NOTHING`,
      [c.hash, c.embedText, c.rawText, c.tokenCount, modelId, toVectorLiteral(vec)],
    )
  }
}

/**
 * Локации файла заменяются целиком, а не пересчитываются построчной дельтой:
 * проще, атомарнее и стоит копейки, потому что вектора уже переиспользованы.
 */
export async function replaceLocations(
  client: pg.PoolClient,
  repoId: number,
  path: string,
  lang: string,
  chunks: PreparedChunk[],
): Promise<void> {
  await client.query('DELETE FROM chunk_locations WHERE repo_id = $1 AND path = $2', [repoId, path])

  for (const c of chunks) {
    await client.query(
      `INSERT INTO chunk_locations
         (repo_id, path, content_hash, start_line, end_line, symbol, kind, parent_chain, lang, exported)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        repoId,
        path,
        c.hash,
        c.startLine,
        c.endLine,
        c.symbol,
        c.kind,
        c.parentChain,
        lang,
        c.exported,
      ],
    )
  }
}

export async function commitFile(
  repoId: number,
  file: FileChunks,
  chunks: PreparedChunk[],
  vectors: Map<string, number[]>,
  modelId: string,
): Promise<void> {
  await tx(async (c) => {
    await insertChunks(c, chunks, vectors, modelId)
    await replaceLocations(c, repoId, file.path, file.lang, chunks)
    await c.query(
      `INSERT INTO files (repo_id, path, blob_sha, lang, indexed_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (repo_id, path)
       DO UPDATE SET blob_sha = EXCLUDED.blob_sha, lang = EXCLUDED.lang, indexed_at = now()`,
      [repoId, file.path, file.blobSha, file.lang],
    )
  })
}

export async function deleteFile(repoId: number, path: string): Promise<void> {
  await tx(async (c) => {
    await c.query('DELETE FROM chunk_locations WHERE repo_id = $1 AND path = $2', [repoId, path])
    await c.query('DELETE FROM files WHERE repo_id = $1 AND path = $2', [repoId, path])
  })
}

/** Чанки, на которые больше никто не ссылается. */
export async function gc(): Promise<number> {
  const { rowCount } = await db().query(`
    DELETE FROM chunks c
     WHERE NOT EXISTS (SELECT 1 FROM chunk_locations l WHERE l.content_hash = c.content_hash)
  `)
  return rowCount ?? 0
}

export async function knownFiles(repoId: number): Promise<Map<string, string>> {
  const { rows } = await db().query<{ path: string; blob_sha: string }>(
    'SELECT path, blob_sha FROM files WHERE repo_id = $1',
    [repoId],
  )
  return new Map(rows.map((r) => [r.path, r.blob_sha]))
}
