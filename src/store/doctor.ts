import { db, tx, toVectorLiteral } from './pool.js'
import { Embedder } from '../embed/client.js'
import { loadConfig } from '../config.js'
import type { GoldenEntry } from '../eval/run.js'

/**
 * Проверка здоровья индекса: сверка приближённой выдачи с точным перебором.
 *
 * Существует из-за конкретного случая. Через индекс прошли вставка и удаление
 * ~120k векторов двух моделей без переиндексации, после чего он начал молча
 * терять целые кластеры: на одном запросе пересечение HNSW-выдачи с точной было
 * НУЛЕВЫМ — правильные кандидаты с косинусом 0.41–0.45 просто отсутствовали,
 * а выдача начиналась с 0.359 (docs/RECALL85.md §3.0).
 *
 * Опасность такого отказа в том, что он беззвучный: запрос отрабатывает,
 * возвращает правдоподобные результаты, ошибок в логах нет. Обнаружить его
 * можно только сравнением с точным перебором, и потому это отдельная команда,
 * а не строка в `scs status`.
 */

export interface IndexHealth {
  /** Средняя доля топ-K приближённой выдачи, совпавшая с точной. */
  overlap: number
  /** Худший запрос: на нём деградация видна раньше всего. */
  worst: { query: string; overlap: number }
  /** Запросов, где ответ есть в точной выдаче, но потерян приближённой. */
  lostAnswers: number
  queries: number
  indexBytes: number
  vectorBytes: number
  /** Вектора ВСЕХ моделей: индекс общий, и раздувают его все поколения. */
  vectors: number
  /** Вектора активной модели — для сопоставления с размером корпуса. */
  activeVectors: number
  efSearch: number
}

const K = 50
/** Байт на вектор в HNSW сверх самих данных: эмпирический ориентир для сигнала о раздувании. */
const BYTES_PER_VECTOR_EXPECTED = 3 * 1024

export async function checkIndex(repo: string, golden: GoldenEntry[]): Promise<IndexHealth> {
  const cfg = loadConfig()
  const embedder = new Embedder()
  const modelId = await embedder.model()

  // Индекс HNSW один на таблицу и содержит вектора ВСЕХ моделей и всех
  // поколений чанкера, поэтому сравнивать его размер с числом векторов только
  // активной модели — значит систематически недооценивать раздувание.
  const { rows: sizes } = await db().query<{ idx: string; vectors: string; active: string }>(
    `SELECT pg_relation_size('chunks_hnsw') AS idx,
            (SELECT count(*) FROM chunks) AS vectors,
            (SELECT count(*) FROM chunks WHERE model_id = $1) AS active`,
    [modelId],
  )
  const vectors = Number(sizes[0]?.vectors ?? 0)
  const activeVectors = Number(sizes[0]?.active ?? 0)
  const indexBytes = Number(sizes[0]?.idx ?? 0)

  const match = (r: { path: string; symbol: string | null; parent_chain: string[] }, want: Set<string>) =>
    want.has(r.path) ||
    (r.symbol ? r.symbol.split(',').some((s) => want.has(`${r.path}::${s.trim()}`)) : false) ||
    (r.parent_chain ?? []).some((p) => want.has(`${r.path}::${p}`))

  let overlapSum = 0
  let lostAnswers = 0
  let worst = { query: '', overlap: 1 }

  for (const entry of golden) {
    const want = new Set(entry.expect)
    const [v] = await embedder.embed([entry.q], 'query')
    const lit = toVectorLiteral(v!)

    type Row = { id: string; path: string; symbol: string | null; parent_chain: string[] }

    // Точный перебор: ORDER BY над join'ом не даёт планировщику применить HNSW.
    const { rows: exact } = await db().query<Row>(
      `SELECT l.id::text, l.path, l.symbol, l.parent_chain
         FROM chunk_locations l JOIN chunks c USING (content_hash) JOIN repos r ON r.id = l.repo_id
        WHERE r.name = $1 AND c.model_id = $3 AND l.path NOT LIKE '@deleted/%'
        ORDER BY c.embedding <=> $2::vector LIMIT ${K}`,
      [repo, lit, modelId],
    )

    // Приближённая: отбор по одной таблице, как в боевом поиске.
    const { rows: approx } = await tx(async (c) => {
      await c.query(`SET LOCAL hnsw.ef_search = ${cfg.search.efSearch}`)
      await c.query('SET LOCAL hnsw.iterative_scan = relaxed_order')
      // Запрос обязан ПОВТОРЯТЬ продовый: если доктор проверяет другую форму
      // отбора, он аттестует не то, что работает у пользователя. Условие
      // EXISTS здесь то же, что в store/search.ts.
      return c.query<Row>(
        `SELECT l.id::text, l.path, l.symbol, l.parent_chain
           FROM (SELECT content_hash, embedding <=> $2::vector AS dist
                   FROM chunks c
                  WHERE model_id = $3
                    AND EXISTS (
                      SELECT 1 FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
                       WHERE l.content_hash = c.content_hash
                         AND r.name = $1 AND l.path NOT LIKE '@deleted/%')
                  ORDER BY embedding <=> $2::vector LIMIT ${K * 2}) cand
           JOIN chunk_locations l ON l.content_hash = cand.content_hash
           JOIN repos r ON r.id = l.repo_id
          WHERE r.name = $1 AND l.path NOT LIKE '@deleted/%'
          ORDER BY cand.dist LIMIT ${K}`,
        [repo, lit, modelId],
      )
    })

    const exactIds = new Set(exact.map((r) => r.id))
    const overlap = exact.length ? approx.filter((r) => exactIds.has(r.id)).length / exact.length : 1
    overlapSum += overlap
    if (overlap < worst.overlap) worst = { query: entry.q, overlap }

    // Хуже средней доли: ответ был доступен точным перебором и потерян индексом.
    if (exact.some((r) => match(r, want)) && !approx.some((r) => match(r, want))) lostAnswers++
  }

  return {
    overlap: golden.length ? overlapSum / golden.length : 1,
    worst,
    lostAnswers,
    queries: golden.length,
    indexBytes,
    vectorBytes: vectors * BYTES_PER_VECTOR_EXPECTED,
    vectors,
    activeVectors,
    efSearch: cfg.search.efSearch,
  }
}

/** Список проблем; пустой — индекс здоров. Вынесен отдельно, чтобы вызывающий
 *  код мог завершиться ненулевым кодом, а не только напечатать текст. */
export function indexProblems(h: IndexHealth): string[] {
  const problems: string[] = []
  const bloat = h.vectorBytes ? h.indexBytes / h.vectorBytes : 0
  if (h.overlap < 0.9) problems.push(`пересечение ${(h.overlap * 100).toFixed(1)}% — индекс деградировал`)
  if (h.worst.overlap < 0.1) problems.push('на одном запросе выдача почти не пересекается с точной')
  if (h.lostAnswers > 0) problems.push(`${h.lostAnswers} ответов не доходят до ранжирования`)
  if (bloat > 2) problems.push(`индекс раздут в ${bloat.toFixed(1)} раза относительно объёма векторов`)
  return problems
}

export function formatHealth(h: IndexHealth): string {
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} МБ`
  const bloat = h.vectorBytes ? h.indexBytes / h.vectorBytes : 0

  const out = [
    `запросов проверено: ${h.queries}, ef_search = ${h.efSearch}`,
    `пересечение с точным перебором: ${(h.overlap * 100).toFixed(1)}%`,
    h.worst.query
      ? `худший запрос: ${(h.worst.overlap * 100).toFixed(0)}% — «${h.worst.query.slice(0, 60)}»`
      : 'худший запрос: расхождений с точным перебором нет',
    `ответов потеряно индексом: ${h.lostAnswers} из ${h.queries}`,
    `индекс ${mb(h.indexBytes)} на ${h.vectors} векторов, из них активной модели ` +
      `${h.activeVectors} (ожидаемо около ${mb(h.vectorBytes)})`,
  ]

  // Пороги КОНСЕРВАТИВНЫЕ, и это следует называть своим именем.
  //
  // Изначально они калибровались по двум состояниям прежнего запроса доктора:
  // деградировавший индекс давал 88.6% в среднем и ноль на худшем запросе,
  // здоровый — 93.2% и 32%. Но потом запрос доктора был приведён к продовому
  // (условие EXISTS), и на здоровом индексе он показывает 100%: прежняя
  // калибровка описывает уже не тот запрос.
  //
  // Пороги оставлены прежними намеренно — они заведомо мягче наблюдаемого
  // сейчас, то есть не поднимают ложных тревог, — но перекалибровать их
  // по настоящей деградации нового запроса ещё предстоит. До тех пор это
  // страховка от катастрофы, а не точная граница нормы.
  const problems = indexProblems(h)

  out.push('')
  if (problems.length) {
    out.push('ПРОБЛЕМЫ:')
    for (const p of problems) out.push(`  • ${p}`)
    out.push('')
    out.push('Лечение: пересоздать индекс и выполнить VACUUM.')
    out.push('  DROP INDEX chunks_hnsw;')
    out.push("  CREATE INDEX chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)")
    out.push('    WITH (m = 16, ef_construction = 200);')
    out.push('  VACUUM ANALYZE chunks;')
    out.push('')
    out.push('Массовое удаление векторов (смена модели, gc после экспериментов)')
    out.push('обязано завершаться пересборкой — иначе отказ будет беззвучным.')
  } else {
    out.push('Индекс здоров.')
  }
  return out.join('\n')
}
