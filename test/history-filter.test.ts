import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { search, findSimilar } from '../src/store/search.js'
import { db, closeDb } from '../src/store/pool.js'
import { loadConfig } from '../src/config.js'
import { DELETED_PREFIX } from '../src/indexer/history.js'

/**
 * Интеграционные проверки исключения истории git из поиска.
 *
 * Модульным тестом это не покрывается принципиально: фильтр живёт в SQL и,
 * что важнее, применяется ПОСЛЕ приближённого отбора HNSW. То есть исторические
 * вектора успевают занять часть overfetch до фильтрации, и вопрос «хватает ли
 * живых кандидатов» решается только на настоящем индексе.
 *
 * Тест самоотключается, если БД, индекс истории или эмбеддер недоступны:
 * падать на машине без поднятого окружения он не должен, но и тихо «проходить»,
 * ничего не проверив, тоже — поэтому пропуск виден в выводе.
 */

const REPO = process.env.SCS_TEST_REPO ?? 'unitify'
const QUERY = 'маршрутизация запроса к платёжному провайдеру'

let ready = false
let skipReason = ''

before(async () => {
  try {
    const { rows } = await db().query<{ live: number; deleted: number }>(
      `SELECT count(*) FILTER (WHERE l.path NOT LIKE $2)::int AS live,
              count(*) FILTER (WHERE l.path LIKE $2)::int     AS deleted
         FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
        WHERE r.name = $1`,
      [REPO, `${DELETED_PREFIX}%`],
    )
    const stats = rows[0]
    if (!stats || stats.live === 0) {
      skipReason = `репозиторий "${REPO}" не проиндексирован`
    } else if (stats.deleted === 0) {
      skipReason = `в индексе нет истории git — запустите: scs history ${REPO}`
    } else {
      const res = await fetch(`${loadConfig().embed.url}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) skipReason = 'эмбеддер не отвечает'
      else ready = true
    }
  } catch (err) {
    skipReason = `окружение недоступно: ${err instanceof Error ? err.message : String(err)}`
  }
})

const guard = (t: { skip: (reason?: string) => void }) => {
  if (!ready) {
    t.skip(skipReason)
    return false
  }
  return true
}

test('по умолчанию история git в выдачу не попадает', async (t) => {
  if (!guard(t)) return
  const hits = await search({ repo: REPO, query: QUERY, k: 20, rerank: false })
  const fromHistory = hits.filter((h) => h.path.startsWith(DELETED_PREFIX))
  assert.equal(fromHistory.length, 0, `в выдаче ${fromHistory.length} удалённых файлов`)
})

test('includeDeleted возвращает историю', async (t) => {
  if (!guard(t)) return
  const hits = await search({
    repo: REPO,
    query: QUERY,
    k: 20,
    rerank: false,
    includeDeleted: true,
    pathGlob: `${DELETED_PREFIX}%`,
  })
  assert.ok(hits.length > 0, 'с includeDeleted и фильтром по пути история не нашлась')
  assert.ok(
    hits.every((h) => h.path.startsWith(DELETED_PREFIX)),
    'фильтр по пути пропустил живой код',
  )
})

/**
 * Главный риск этапа 0: фильтр стоит после ANN-отбора, поэтому исторические
 * вектора съедают часть overfetch. Если запас мал, выдача живого кода окажется
 * короче запрошенного — молча, потому что ошибки при этом не возникает.
 */
test('исключение истории не обедняет выдачу живого кода', async (t) => {
  if (!guard(t)) return
  const k = 20
  for (const query of [QUERY, 'проверка прав доступа сотрудника к заявке', 'импорт показаний счётчиков']) {
    const hits = await search({ repo: REPO, query, k, rerank: false, maxPerFile: 99 })
    assert.equal(hits.length, k, `«${query}»: вернулось ${hits.length} из ${k} — overfetch съеден историей`)
  }
})

test('точный проход под фильтрами тоже исключает историю', async (t) => {
  if (!guard(t)) return
  // pathGlob включает ветку полного перебора — там фильтр отдельный, и однажды
  // именно на этом пути запрос падал на числе параметров.
  const hits = await search({ repo: REPO, query: QUERY, k: 10, rerank: false, pathGlob: 'apps/%' })
  assert.ok(hits.length > 0, 'фильтрованный поиск ничего не вернул')
  assert.ok(hits.every((h) => !h.path.startsWith(DELETED_PREFIX)), 'история просочилась через точный проход')
})

/**
 * Тот же фильтр в поиске дублей. Отдельным тестом, потому что это не «ещё один
 * вызов того же SQL»: у findSimilar свой запрос, и в него фильтр истории просто
 * не был добавлен. Обнаружилось на живой работе — у файла, только что
 * переписанного с .js на .ts, все шесть результатов оказались его собственным
 * прошлым с близостью 0.96. Единственная защита, exclude_same_file, сравнивает
 * пути, а у копии из истории путь другой.
 */
test('поиск дублей по умолчанию не выдаёт историю git', async (t) => {
  if (!guard(t)) return
  const { rows } = await db().query<{ path: string; start_line: number }>(
    `SELECT l.path, l.start_line FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
      WHERE r.name = $1 AND l.path NOT LIKE $2 AND l.symbol IS NOT NULL
      ORDER BY l.path LIMIT 1`,
    [REPO, `${DELETED_PREFIX}%`],
  )
  const anchor = rows[0]
  assert.ok(anchor, 'в индексе нет ни одного живого чанка с символом')
  const hits = await findSimilar(REPO, anchor.path, anchor.start_line, 20, true)
  const fromHistory = hits.filter((h) => h.path.startsWith(DELETED_PREFIX))
  assert.equal(fromHistory.length, 0, `в дублях ${fromHistory.length} удалённых файлов`)
})

test('include_history в поиске дублей возвращает прошлое файла', async (t) => {
  if (!guard(t)) return
  // Ищем ровно ту пару, на которой дефект и проявился: живой файл и его предок
  // из истории с тем же именем, но другим расширением (миграция .js → .ts).
  const { rows } = await db().query<{ path: string; start_line: number }>(
    `SELECT l.path, min(l.start_line)::int AS start_line
       FROM chunk_locations l JOIN repos r ON r.id = l.repo_id
      WHERE r.name = $1 AND l.path ~ '\\.tsx?$'
        AND EXISTS (
          SELECT 1 FROM chunk_locations d
           WHERE d.repo_id = l.repo_id AND d.path ~ ('^' || $2 || '.*\\.jsx?$')
             -- Путь без префикса и расширения: живой x.ts и удалённый x.js.
             -- Флаг 'g' здесь был бы ошибкой — он вырезает совпадения по всей
             -- строке, и тогда под условие подходят любые одноимённые файлы
             -- любых расширений, а проверка молча уезжает на другой случай.
             AND regexp_replace(d.path, '^' || $2 || '(.*)\\.jsx?$', '\\1')
               = regexp_replace(l.path, '\\.tsx?$', '')
        )
      GROUP BY l.path ORDER BY l.path LIMIT 1`,
    [REPO, DELETED_PREFIX],
  )
  const anchor = rows[0]
  if (!anchor) {
    t.skip('в индексе нет пары «живой .ts — удалённый .js» — проверять нечего')
    return
  }
  const hits = await findSimilar(REPO, anchor.path, anchor.start_line, 20, true, true)
  assert.ok(
    hits.some((h) => h.path.startsWith(DELETED_PREFIX)),
    `с include_history история не вернулась для ${anchor.path}`,
  )
})

test('CLI и MCP передают флаг, а не игнорируют его', async () => {
  // Проверяем не поведение поиска, а проводку: параметр легко добавить в схему
  // и забыть прокинуть в вызов — тогда флаг молча ничего не делает.
  const [cli, mcp] = await Promise.all([
    import('node:fs/promises').then((fs) => fs.readFile('src/bin/scs.ts', 'utf8')),
    import('node:fs/promises').then((fs) => fs.readFile('src/mcp/server.ts', 'utf8')),
  ])
  assert.match(cli, /includeDeleted: opts\.history/, 'CLI не прокидывает --history в search()')
  assert.match(mcp, /include_history/, 'в схеме MCP нет include_history')
  assert.match(mcp, /includeDeleted: include_history/, 'MCP не прокидывает include_history в search()')
  assert.match(cli, /opts\.history,\n\s*\)/, 'CLI не прокидывает --history в findSimilar()')
  assert.match(
    mcp,
    /include_history \?\? cfg\.search\.includeDeleted/,
    'MCP не прокидывает include_history в findSimilar()',
  )
})

test.after(async () => {
  await closeDb()
})
