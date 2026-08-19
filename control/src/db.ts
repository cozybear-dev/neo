import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

export type Db = pg.Pool

export function createPool(databaseUrl: string): Db {
  return new Pool({ connectionString: databaseUrl })
}

export async function migrate(pool: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'migrations', '001_init.sql'),
    join(here, '..', '..', 'migrations', '001_init.sql'),
  ]
  let sql: string | undefined
  for (const path of candidates) {
    try {
      sql = await readFile(path, 'utf8')
      break
    } catch {
      // try next
    }
  }
  if (!sql) {
    throw new Error('control: migration 001_init.sql not found')
  }
  await pool.query(sql)
}
