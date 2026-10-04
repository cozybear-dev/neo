import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
export type Db = pg.Pool
export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  })
  pool.on('error', (error) => {
    console.error(
      JSON.stringify({
        event: 'database_pool_error',
        code: (error as any).code ?? 'unknown',
      }),
    )
  })
  return pool
}
export async function migrate(
  pool: Db,
  migrationDirectory?: string,
): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  let directory = migrationDirectory ?? ''
  if (!directory)
    for (const candidate of [
      join(here, '..', 'migrations'),
      join(here, '..', '..', 'migrations'),
    ]) {
      try {
        await readdir(candidate)
        directory = candidate
        break
      } catch {}
    }
  if (!directory) throw new Error('control: migrations not found')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(78129041)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT',
    )
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(join(directory, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const done = await client.query(
        'SELECT name,checksum FROM schema_migrations WHERE name=$1',
        [name],
      )
      if (
        done.rowCount &&
        done.rows[0].checksum &&
        done.rows[0].checksum !== checksum
      )
        throw new Error(`migration checksum mismatch: ${name}`)
      if (done.rowCount && !done.rows[0].checksum)
        await client.query(
          'UPDATE schema_migrations SET checksum=$2 WHERE name=$1',
          [name, checksum],
        )
      if (!done.rowCount) {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, checksum],
        )
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
