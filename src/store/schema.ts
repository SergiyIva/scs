import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, tx } from './pool.js'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

/**
 * Применяет неприменённые миграции по возрастанию имени.
 * Каждая идёт в своей транзакции, чтобы падение третьей не откатывало первые две.
 */
export async function migrate(): Promise<string[]> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await db().query<{ name: string }>('SELECT name FROM _migrations')
  const applied = new Set(rows.map((r) => r.name))

  const pending = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f))

  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
    await tx(async (c) => {
      await c.query(sql)
      await c.query('INSERT INTO _migrations (name) VALUES ($1)', [name])
    })
  }

  return pending
}

export interface DbStatus {
  connected: boolean
  migrations: string[]
  repos: { name: string; files: number; chunks: number; lastIndexed: Date | null }[]
  totalChunks: number
}

export async function status(): Promise<DbStatus> {
  const { rows: migrations } = await db().query<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY name',
  )
  // Считаем подзапросами, а не двумя LEFT JOIN от одной таблицы: те давали
  // декартово произведение, и на монорепе (7098 файлов × 54 237 локаций ≈
  // 385 млн строк до агрегации) `scs status` просто зависал. На корпусе из
  // 33 файлов это было незаметно — ещё один запрос, «работавший» ровно
  // до первого настоящего объёма.
  const { rows: repos } = await db().query(`
    SELECT r.name,
           r.last_indexed_at AS "lastIndexed",
           (SELECT count(*)::int FROM files f           WHERE f.repo_id = r.id) AS files,
           (SELECT count(*)::int FROM chunk_locations l WHERE l.repo_id = r.id) AS chunks
      FROM repos r
     ORDER BY r.name
  `)
  const { rows: total } = await db().query<{ n: string }>('SELECT count(*) AS n FROM chunks')

  return {
    connected: true,
    migrations: migrations.map((m) => m.name),
    repos,
    totalChunks: Number(total[0]?.n ?? 0),
  }
}
