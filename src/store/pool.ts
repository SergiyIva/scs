import pg from 'pg'
import { loadConfig } from '../config.js'

let pool: pg.Pool | undefined

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadConfig().pg, max: 8 })
    pool.on('error', (err) => console.error('[pg] ошибка простаивающего клиента:', err.message))
  }
  return pool
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}

/** Транзакция с гарантированным release клиента. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** pgvector принимает вектор как строку вида '[0.1,0.2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}
