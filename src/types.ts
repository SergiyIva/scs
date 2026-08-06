/** Запрос и документ эмбеддятся с разными префиксами — см. services/embed-ollama. */
export type EmbedKind = 'query' | 'document'

export type ChunkKind =
  | 'function'
  | 'method'
  | 'class'
  | 'component'
  | 'type'
  | 'preamble'
  | 'file_card'

/** Результат работы чанкера: ещё без вектора и без content_hash. */
export interface RawChunk {
  /** Что уйдёт в модель: обогащающий заголовок + код. */
  embedText: string
  /** Что покажем человеку: чистый код без заголовка. */
  rawText: string
  startLine: number
  endLine: number
  symbol: string | null
  kind: ChunkKind
  parentChain: string[]
  exported: boolean
  tokenCount: number
}

export interface FileChunks {
  path: string
  lang: string
  blobSha: string
  chunks: RawChunk[]
}

export interface SearchHit {
  path: string
  startLine: number
  endLine: number
  symbol: string | null
  kind: ChunkKind
  parentChain: string[]
  lang: string
  rawText: string
  score: number
  /** Из какой половины гибрида пришёл результат — для отладки ранжирования. */
  via: 'vector' | 'lexical' | 'both'
}

export interface EmbedResponse {
  vectors: number[][]
  model: string
  dims: number
  normalized: boolean
  truncated: boolean[]
}
