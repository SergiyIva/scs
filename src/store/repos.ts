import { db } from './pool.js'

export interface RepoRow {
  id: number
  name: string
  root_path: string
  head_commit: string | null
  last_indexed_at: Date | null
}

export async function upsertRepo(name: string, rootPath: string): Promise<RepoRow> {
  const { rows } = await db().query<RepoRow>(
    `INSERT INTO repos (name, root_path) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET root_path = EXCLUDED.root_path
     RETURNING *`,
    [name, rootPath],
  )
  return rows[0]!
}

export async function getRepo(name: string): Promise<RepoRow | null> {
  const { rows } = await db().query<RepoRow>('SELECT * FROM repos WHERE name = $1', [name])
  return rows[0] ?? null
}

export async function requireRepo(name: string): Promise<RepoRow> {
  const repo = await getRepo(name)
  if (!repo) throw new Error(`Репозиторий "${name}" не проиндексирован. Запустите: scs index ${name}`)
  return repo
}

export async function markIndexed(repoId: number, headCommit: string | null): Promise<void> {
  await db().query(
    'UPDATE repos SET last_indexed_at = now(), head_commit = $2 WHERE id = $1',
    [repoId, headCommit],
  )
}
