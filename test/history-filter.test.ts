import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { search } from '../src/store/search.js'
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
})

test.after(async () => {
  await closeDb()
})
