import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
const name = `neo-test-db-${randomUUID()}`
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.error?.message || 'Docker command failed',
    )
  return result.stdout.trim()
}
let started = false
try {
  let database = process.env.TEST_DATABASE_URL
  if (!database) {
    const password = randomBytes(24).toString('hex')
    docker([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_USER=neo',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=neo_test',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ])
    started = true
    const endpoint = docker(['port', name, '5432/tcp'])
    database = `postgres://neo:${password}@${endpoint}/neo_test`
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      if (
        spawnSync(
          'docker',
          ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'neo'],
          { stdio: 'ignore' },
        ).status === 0
      ) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!ready) throw new Error('Disposable Postgres did not become ready')
  }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'control/src/server.test.ts'],
    { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: database } },
  )
  process.exitCode = result.status || (result.error ? 1 : 0)
} finally {
  if (started) docker(['rm', '-f', name])
}
