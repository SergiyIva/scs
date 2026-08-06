/** Запрос и документ эмбеддятся с разными префиксами — см. services/embed-ollama. */
export type EmbedKind = 'query' | 'document'

export type ChunkKind =
  | 'function'
  | 'method'
  | 'class'
  | 'component'
  | 'type'
  /**
   * Именованная привязка верхнего уровня, не являющаяся функцией:
   * `const UserRightsSet = new GQLListSchema(...)`, крупный конфиг, таблица
   * констант. В Keystone-подобных кодовых базах так объявлена бо́льшая часть
   * доменной логики, и без этого вида она оставалась безымянной.
   * Этим же видом помечаются непокрытые AST-промежутки между объявлениями.
   */
  | 'binding'
  | 'preamble'
  | 'file_card'
  /** Раздел документации: заголовок Markdown и текст до следующего заголовка. */
  | 'section'

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
  /** Обогащённый текст — то, что видела модель. Нужен реранкеру, человеку не показывается. */
  embedText?: string
  /** Ранг после RRF-слияния. Задаёт порядок, но не годится для оценки релевантности. */
  score: number
  /** Косинусная близость к запросу: вот по ней видно, релевантен ли результат. */
  sim: number | null
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
