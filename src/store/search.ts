import type { SearchHit, ChunkKind } from '../types.js'
import { db, toVectorLiteral } from './pool.js'
import { loadConfig } from '../config.js'
import { Embedder } from '../embed/client.js'

export type SearchMode = 'hybrid' | 'semantic' | 'lexical'

export interface SearchOptions {
  repo: string
  query: string
  k?: number
  mode?: SearchMode
  pathGlob?: string
  lang?: string
  maxPerFile?: number
}

interface Row {
  path: string
  start_line: number
  end_line: number
  symbol: string | null
  kind: ChunkKind
  parent_chain: string[]
  lang: string
  raw_text: string
  score: string
  sim: string | null
  in_vec: boolean
  in_lex: boolean
}

/**
 * Поиск: вектор, лексика или их слияние по RRF.
 *
 * RRF (Reciprocal Rank Fusion) выбран вместо взвешенной суммы намеренно:
 * косинусная близость и ts_rank живут в несопоставимых шкалах, и подбор весов
 * между ними — бесконечная возня. RRF работает по рангам и калибровки не требует.
 *
 * Режим по умолчанию — 'semantic', а не 'hybrid'. Замеры показали, что на наших
 * корпусах лексическая ветка только ухудшает ранжирование (docs/DESIGN.md §9).
 * Ветка сохранена: она мгновенная (1-2 мс) и может понадобиться на большом
 * корпусе, где вектору труднее.
 */
export async function search(opts: SearchOptions): Promise<SearchHit[]> {
  const cfg = loadConfig()
  const k = opts.k ?? cfg.search.topK
  const mode = opts.mode ?? cfg.search.defaultMode
  const candidates = cfg.search.candidates
  const rrfK = cfg.search.rrfK
  const maxPerFile = opts.maxPerFile ?? cfg.search.maxPerFile

  const useVec = mode !== 'lexical'
  const useLex = mode !== 'semantic'

  let vecLiteral: string | null = null
  if (useVec) {
    const [v] = await new Embedder().embed([opts.query], 'query')
    if (!v) throw new Error('эмбеддер не вернул вектор запроса')
    vecLiteral = toVectorLiteral(v)
  }

  const sql = `
    WITH repo AS (SELECT id FROM repos WHERE name = $1),
    filtered AS (
      SELECT l.id, l.content_hash, l.path, l.start_line, l.end_line, l.symbol,
             l.kind, l.parent_chain, l.lang, c.embedding, c.tsv, c.raw_text
        FROM chunk_locations l
        JOIN chunks c ON c.content_hash = l.content_hash
       WHERE l.repo_id = (SELECT id FROM repo)
         AND ($4::text IS NULL OR l.path LIKE $4)
         AND ($5::text IS NULL OR l.lang = $5)
    ),
    vec AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
        FROM filtered
       WHERE $2::vector IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $6
    ),
    lex AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(tsv, q) DESC) AS rank
        FROM filtered, code_query($3) q
       WHERE $7::bool AND q != ''::tsquery AND tsv @@ q
       ORDER BY ts_rank(tsv, q) DESC
       LIMIT $6
    ),
    fused AS (
      SELECT id,
             SUM(w / ($8 + rank))                          AS score,
             bool_or(src = 'vec')                          AS in_vec,
             bool_or(src = 'lex')                          AS in_lex
        FROM (
          SELECT id, rank, 'vec' AS src, $10::float8 AS w FROM vec
          UNION ALL
          SELECT id, rank, 'lex' AS src, $11::float8 AS w FROM lex
        ) u
       GROUP BY id
    )
    SELECT f.path, f.start_line, f.end_line, f.symbol, f.kind, f.parent_chain,
           f.lang, f.raw_text, fu.score::text AS score, fu.in_vec, fu.in_lex,
           -- RRF задаёт порядок, но его шкала (1/(k+rank)) ничего не говорит
           -- о том, релевантен ли результат вообще. Косинус говорит.
           CASE WHEN $2::vector IS NULL THEN NULL
                ELSE (1 - (f.embedding <=> $2::vector))::text
           END AS sim
      FROM fused fu
      JOIN filtered f ON f.id = fu.id
     ORDER BY fu.score * (CASE WHEN f.kind = 'file_card' THEN $12::float8 ELSE 1 END) DESC
     LIMIT $9
  `

  const { rows } = await db().query<Row>(sql, [
    opts.repo,
    vecLiteral,
    opts.query,
    opts.pathGlob ?? null,
    opts.lang ?? null,
    candidates,
    useLex,
    rrfK,
    // Берём с запасом: диверсификация ниже отбросит лишние чанки одного файла.
    Math.max(k * 4, 40),
    cfg.search.vectorWeight,
    cfg.search.lexicalWeight,
    cfg.search.fileCardPrior,
  ])

  const hits: SearchHit[] = rows.map((r) => ({
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    symbol: r.symbol,
    kind: r.kind,
    parentChain: r.parent_chain,
    lang: r.lang,
    rawText: r.raw_text,
    score: Number(r.score),
    sim: r.sim === null ? null : Number(r.sim),
    via: r.in_vec && r.in_lex ? 'both' : r.in_vec ? 'vector' : 'lexical',
  }))

  return diversify(hits, k, maxPerFile)
}

/**
 * Без этого топ-5 регулярно оказывается пятью соседними чанками одного файла:
 * контекст потрачен, а обзора нет.
 */
function diversify(hits: SearchHit[], k: number, maxPerFile: number): SearchHit[] {
  const perFile = new Map<string, number>()
  const kept: SearchHit[] = []
  const overflow: SearchHit[] = []

  for (const h of hits) {
    const n = perFile.get(h.path) ?? 0
    if (n < maxPerFile) {
      perFile.set(h.path, n + 1)
      kept.push(h)
    } else {
      overflow.push(h)
    }
    if (kept.length >= k) break
  }

  // Если файлов не хватило на k результатов — добираем ранее отброшенными.
  if (kept.length < k) kept.push(...overflow.slice(0, k - kept.length))
  return kept.slice(0, k)
}

/** Похожие по смыслу чанки — второй ключевой сценарий: дубли логики. */
export async function findSimilar(
  repo: string,
  path: string,
  line: number,
  k: number,
  excludeSameFile: boolean,
): Promise<SearchHit[]> {
  const { rows } = await db().query<{ content_hash: Buffer }>(
    `SELECT l.content_hash
       FROM chunk_locations l
       JOIN repos r ON r.id = l.repo_id
      WHERE r.name = $1 AND l.path = $2 AND $3 BETWEEN l.start_line AND l.end_line
      ORDER BY (l.end_line - l.start_line) ASC
      LIMIT 1`,
    [repo, path, line],
  )
  const anchor = rows[0]
  if (!anchor) throw new Error(`в ${path}:${line} нет проиндексированного чанка`)

  const { rows: hits } = await db().query<Row>(
    `SELECT l.path, l.start_line, l.end_line, l.symbol, l.kind, l.parent_chain, l.lang,
            c.raw_text, (1 - (c.embedding <=> a.embedding))::text AS score,
            true AS in_vec, false AS in_lex
       FROM chunks a
       CROSS JOIN LATERAL (
         SELECT c2.* FROM chunks c2 WHERE c2.content_hash <> a.content_hash
       ) c
       JOIN chunk_locations l ON l.content_hash = c.content_hash
       JOIN repos r ON r.id = l.repo_id
      WHERE a.content_hash = $1
        AND r.name = $2
        AND ($3::bool = false OR l.path <> $4)
      ORDER BY c.embedding <=> a.embedding
      LIMIT $5`,
    [anchor.content_hash, repo, excludeSameFile, path, k],
  )

  return hits.map((r) => ({
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    symbol: r.symbol,
    kind: r.kind,
    parentChain: r.parent_chain,
    lang: r.lang,
    rawText: r.raw_text,
    score: Number(r.score),
    sim: Number(r.score),
    via: 'vector' as const,
  }))
}
