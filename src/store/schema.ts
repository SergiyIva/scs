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
  const { rows: repos } = await db().query(`
    SELECT r.name,
           r.last_indexed_at                    AS "lastIndexed",
           count(DISTINCT f.path)::int          AS files,
           count(DISTINCT l.id)::int            AS chunks
      FROM repos r
      LEFT JOIN files f           ON f.repo_id = r.id
      LEFT JOIN chunk_locations l ON l.repo_id = r.id
     GROUP BY r.id, r.name, r.last_indexed_at
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
