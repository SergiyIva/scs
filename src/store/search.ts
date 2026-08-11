import type { SearchHit, ChunkKind } from '../types.js'
import { db, tx, toVectorLiteral } from './pool.js'
import { loadConfig } from '../config.js'
import { Embedder } from '../embed/client.js'
import { compilePriors } from './priors.js'
import { Reranker } from '../rerank/client.js'

export type SearchMode = 'hybrid' | 'semantic' | 'lexical'

/**
 * Во сколько раз больше чанков берём из HNSW, чем нужно локаций.
 * Один вектор может быть общим для нескольких мест (копипаста, другая ветка),
 * плюс часть кандидатов отсеется фильтром по репозиторию.
 */
const VEC_OVERFETCH = 2

export interface SearchOptions {
  repo: string
  query: string
  k?: number
  mode?: SearchMode
  pathGlob?: string
  lang?: string
  maxPerFile?: number
  /** Перекрывает search.rerank.enabled — нужно для замеров «с» и «без». */
  rerank?: boolean
  /** Искать и по удалённому коду из истории git (§21). По умолчанию нет. */
  includeDeleted?: boolean
  /**
   * Падать, если реранкер недоступен, вместо тихого возврата к порядку эмбеддера.
   * Нужно приёмке: для пользователя деградация лучше отказа, а для аттестации
   * наоборот — измеренной оказалась бы не та система.
   */
  strictRerank?: boolean
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
  embed_text: string
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
  let modelId: string | null = null
  if (useVec) {
    const embedder = new Embedder()
    // Идентификатор модели нужен как фильтр: в таблице chunks могут лежать
    // вектора нескольких моделей (A/B по §18, смена модели, недочищенный старый
    // индекс). Они несравнимы между собой, и без фильтра приближённый отбор
    // тратил бы кандидатов на чужое пространство — молча и без ошибки.
    modelId = await embedder.model()
    const [v] = await embedder.embed([opts.query], 'query')
    if (!v) throw new Error('эмбеддер не вернул вектор запроса')
    vecLiteral = toVectorLiteral(v)
  }

  // Фильтры по пути и языку применяются ПОСЛЕ векторного отбора, поэтому под
  // ними приближённый поиск может не набрать кандидатов вовсе. В этом случае
  // честнее заплатить полным перебором: он медленный, но точный.
  const filtered = Boolean(opts.pathGlob || opts.lang)
  // История git — отдельное пространство: она отвечает на «где это было раньше»
  // и в обычном поиске только конкурирует с живым кодом (§21).
  const includeDeleted = opts.includeDeleted ?? cfg.search.includeDeleted

  /**
   * Векторная ветка. Замер на 39 655 чанках показал, что решает не настройка
   * HNSW, а форма запроса: пока ORDER BY стоит над join'ом chunk_locations
   * с chunks, планировщик не может воспользоваться индексом и считает
   * расстояние до КАЖДОГО вектора — 194 мс на запрос. Если же отбор идёт
   * по одной таблице chunks, включается HNSW и остаётся 5 мс при совпадении
   * выдачи с точной на 97% (ef_search=200, кандидатов вдвое больше нужного).
   */
  const vecSql = filtered
    ? `SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
         FROM filtered
        WHERE $2::vector IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $6`
    : `SELECT id, ROW_NUMBER() OVER (ORDER BY dist) AS rank FROM (
         SELECT l.id, cand.dist
           FROM (SELECT content_hash, embedding <=> $2::vector AS dist
                   FROM chunks c
                  WHERE $2::vector IS NOT NULL
                    AND model_id = $12
                    -- Годным считается только чанк, у которого есть локация
                    -- в нужном репозитории. Без этого условия кандидатов молча
                    -- съедали ДВА класса лишних векторов: история git и —
                    -- гораздо хуже — осиротевшие вектора прошлых конфигураций
                    -- чанкера, которые остаются в таблице до сборки мусора.
                    -- Отбор шёл по chunks, фильтрация — после join'а, поэтому
                    -- на запрос возвращалось 9 результатов вместо 20, и ошибки
                    -- при этом не возникало. Итеративный обход HNSW (включён
                    -- ниже) продолжает поиск, пока не наберёт нужное число.
                    AND EXISTS (
                      SELECT 1 FROM chunk_locations l
                       WHERE l.content_hash = c.content_hash
                         AND l.repo_id = (SELECT id FROM repo)
                         AND ($13::bool OR l.path NOT LIKE '@deleted/%')
                    )
                  ORDER BY embedding <=> $2::vector
                  LIMIT $6 * ${VEC_OVERFETCH}) cand
           JOIN chunk_locations l ON l.content_hash = cand.content_hash
          WHERE l.repo_id = (SELECT id FROM repo)
            AND ($13::bool OR l.path NOT LIKE '@deleted/%')
          ORDER BY cand.dist
          LIMIT $6
       ) ranked`

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
         -- Фильтр по модели нужен и здесь: вектора разных моделей несравнимы,
         -- а без упоминания $12 в этой ветке запрос ещё и падал на числе
         -- параметров — ошибка вылезала только под --path и --lang.
         AND ($12::text IS NULL OR c.model_id = $12)
         AND ($13::bool OR l.path NOT LIKE '@deleted/%')
    ),
    vec AS (
      ${vecSql}
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
    -- Достаём тексты по первичному ключу локации, а НЕ через filtered:
    -- CTE filtered материализуется (на неё ссылается лексическая ветка),
    -- и join с ней возвращал бы полный проход по всем локациям репозитория
    -- ради полусотни строк — на 40k чанков это стоило ~80 мс.
    SELECT l.path, l.start_line, l.end_line, l.symbol, l.kind, l.parent_chain,
           l.lang, c.raw_text, c.embed_text, fu.score::text AS score, fu.in_vec, fu.in_lex,
           -- RRF задаёт порядок, но его шкала (1/(k+rank)) ничего не говорит
           -- о том, релевантен ли результат вообще. Косинус говорит.
           CASE WHEN $2::vector IS NULL THEN NULL
                ELSE (1 - (c.embedding <=> $2::vector))::text
           END AS sim
      FROM fused fu
      JOIN chunk_locations l ON l.id = fu.id
      JOIN chunks c ON c.content_hash = l.content_hash
     ORDER BY fu.score DESC
     LIMIT $9
  `

  const params = [
    opts.repo,
    vecLiteral,
    opts.query,
    opts.pathGlob ?? null,
    opts.lang ?? null,
    candidates,
    useLex,
    rrfK,
    // Берём с запасом: приоритеты и диверсификация ниже отбросят часть кандидатов.
    Math.max(k * 6, 60),
    cfg.search.vectorWeight,
    cfg.search.lexicalWeight,
    modelId,
    includeDeleted,
  ]

  // ef_search задаётся на сессию, поэтому запрос идёт в транзакции с SET LOCAL:
  // иначе настройка утекала бы на соседние запросы из того же пула.
  // 200 — измеренный компромисс: при 40 (умолчание pgvector) выдача совпадает
  // с точной лишь на 69%, при 600 совпадает полностью, но стоит уже 80 мс.
  const { rows } = await tx(async (c) => {
    if (!filtered) {
      await c.query(`SET LOCAL hnsw.ef_search = ${cfg.search.efSearch}`)
      // Фильтр по model_id отсекает часть найденного индексом, и без итеративного
      // обхода кандидатов может не хватить: pgvector вернул бы меньше, чем просили,
      // не сообщив об этом.
      await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    }
    return c.query<Row>(sql, params)
  })

  const hits: SearchHit[] = rows.map((r) => ({
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    symbol: r.symbol,
    kind: r.kind,
    parentChain: r.parent_chain,
    lang: r.lang,
    rawText: r.raw_text,
    embedText: r.embed_text,
    score: Number(r.score),
    sim: r.sim === null ? null : Number(r.sim),
    via: r.in_vec && r.in_lex ? 'both' : r.in_vec ? 'vector' : 'lexical',
  }))

  // Приоритеты применяются здесь, а не в SQL: шаблоны путей — это glob, который
  // в SQL выражается плохо, а список штрафов задаётся конфигом пользователя.
  const priors = compilePriors(cfg)
  const ranked = hits
    .map((h) => ({ h, s: h.score * priors.apply(h) }))
    .sort((a, b) => b.s - a.s)
    .map(({ h, s }) => ({ ...h, score: s }))

  const useRerank = opts.rerank ?? cfg.search.rerank.enabled
  const reranked = useRerank
    ? await rerankHits(ranked, opts.query, priors, opts.strictRerank === true)
    : ranked

  return diversify(reranked, k, maxPerFile)
}

/**
 * Переупорядочивание коротким списком через cross-encoder.
 *
 * Реранкер видит пару «запрос ↔ текст чанка» целиком и потому судит точнее
 * эмбеддера, но стоит на три порядка дороже — отсюда работа только по верхушке.
 * Скор реранкера домножается на те же априорные множители: cross-encoder не
 * знает, что перед ним тест или карточка файла, а мы знаем.
 *
 * Хвост за пределами candidates сохраняет исходный порядок и уходит вниз:
 * выбрасывать его нельзя, иначе фильтр по числу файлов останется без запаса.
 */
async function rerankHits(
  hits: SearchHit[],
  query: string,
  priors: ReturnType<typeof compilePriors>,
  strict = false,
): Promise<SearchHit[]> {
  const cfg = loadConfig()
  const head = hits.slice(0, cfg.search.rerank.candidates)
  const tail = hits.slice(cfg.search.rerank.candidates)
  if (!head.length) return hits

  // Реранкеру отдаём ровно то, что видела модель при индексации: обогащённый
  // текст с путём, экспортами и строкой документации. Вариант «путь + чистый код»
  // замерен и оказался не лучше (§20).
  const documents = head.map((h) => h.embedText ?? h.rawText)

  const scores = await new Reranker().score(query, documents)
  if (!scores) {
    if (strict) throw new Error('реранкер недоступен, а прогон требует продовой конфигурации')
    return hits
  }

  const rescored = head
    .map((h, i) => ({ ...h, score: scores[i]! * priors.apply(h) }))
    .sort((a, b) => b.score - a.score)

  if (cfg.search.rerank.fusion === 'replace') return [...rescored, ...tail]

  /**
   * Слияние двух порядков вместо замены одного другим.
   *
   * Замер: чистая замена поднимает recall@5 с 37.9% до 41.4%, но роняет recall@1
   * с 19.0% до 15.5%. Причина понятна — cross-encoder вытаскивает середину пула,
   * но сдвигает уверенное первое место bi-encoder'а. Обе ветви правы по-своему,
   * а их шкалы несравнимы: сигмоида логита против RRF-скора. Ровно та задача,
   * для которой в §8 уже выбран RRF — он работает по рангам и калибровки
   * не требует.
   */
  const rank = new Map<SearchHit, { vec: number; ce: number }>()
  head.forEach((h, i) => rank.set(h, { vec: i + 1, ce: 0 }))
  rescored.forEach((h, i) => {
    const orig = head.find((x) => x.path === h.path && x.startLine === h.startLine)
    if (orig) rank.get(orig)!.ce = i + 1
  })

  const k = cfg.search.rrfK
  const fused = head
    .map((h) => {
      const r = rank.get(h)!
      return { ...h, score: 1 / (k + r.vec) + cfg.search.rerank.weight / (k + r.ce) }
    })
    .sort((a, b) => b.score - a.score)

  return [...fused, ...tail]
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
