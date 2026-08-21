import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { checkScope, buildApp, matchPattern } from './server.js'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://neo:neo@127.0.0.1:5432/neo'

async function canReachPostgres(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

describe('scope matching (unit)', () => {
  it('denies when allowlist is empty (default deny)', () => {
    const result = checkScope({
      target: 'evil.example',
      envAllowlist: [],
    })
    assert.equal(result.allowed, false)
    assert.match(result.reason, /default deny/)
  })

  it('allows env allowlist glob match', () => {
    const result = checkScope({
      target: 'app.lab.internal',
      envAllowlist: ['localhost', '*.lab.internal'],
    })
    assert.equal(result.allowed, true)
    assert.equal(result.matched, '*.lab.internal')
  })

  it('denies when target misses allowlist', () => {
    const result = checkScope({
      target: 'not-in-scope.example',
      envAllowlist: ['localhost', '*.lab.internal', 'juice-shop'],
    })
    assert.equal(result.allowed, false)
    assert.equal(result.matched, '')
  })

  it('denylist wins over allowlist', () => {
    const result = checkScope({
      target: 'blocked.lab.internal',
      envAllowlist: ['*.lab.internal'],
      taskDenylist: ['blocked.lab.internal'],
    })
    assert.equal(result.allowed, false)
    assert.equal(result.matched, 'blocked.lab.internal')
    assert.match(result.reason, /denylist/)
  })

  it('matchPattern respects exact hosts', () => {
    assert.equal(matchPattern(['juice-shop'], 'juice-shop'), 'juice-shop')
    assert.equal(matchPattern(['juice-shop'], 'other'), null)
  })

  it('matches URL targets against hostname allowlist', () => {
    const result = checkScope({
      target: 'https://huntandhackett.com/path?q=1',
      envAllowlist: ['huntandhackett.com'],
    })
    assert.equal(result.allowed, true)
    assert.equal(result.matched, 'huntandhackett.com')
  })

  it('does not let example.com allow www.example.com', () => {
    const result = checkScope({
      target: 'https://www.huntandhackett.com',
      envAllowlist: ['huntandhackett.com'],
    })
    assert.equal(result.allowed, false)
  })

  it('lets *.example.com match apex', () => {
    const result = checkScope({
      target: 'huntandhackett.com',
      envAllowlist: ['*.huntandhackett.com'],
    })
    assert.equal(result.allowed, true)
  })
})

const live = await canReachPostgres()

describe('control API (postgres)', { skip: !live }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  const pool = new pg.Pool({ connectionString: DATABASE_URL })

  before(async () => {
    app = await buildApp({
      databaseUrl: DATABASE_URL,
      allowlistEnv: 'localhost,127.0.0.1,*.lab.internal,juice-shop',
      pool,
    })
  })

  after(async () => {
    await app.close()
    await pool.end()
  })

  it('GET /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
  })

  it('POST /scope/check denies out-of-scope target', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/scope/check',
      payload: { target: 'attacker.example' },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.allowed, false)
    assert.match(body.reason, /default deny/)
  })

  it('POST /scope/check allows env allowlist host', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/scope/check',
      payload: { target: 'juice-shop' },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.allowed, true)
    assert.equal(body.matched, 'juice-shop')
  })

  it('POST /scope/check merges task allowlist', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        mode: 'fast',
        objective: 'scope merge',
        allowlist: ['unique-task-host.example'],
      },
    })
    assert.equal(create.statusCode, 201)
    const taskId = create.json().id as string

    const denied = await app.inject({
      method: 'POST',
      url: '/scope/check',
      payload: { target: 'unique-task-host.example' },
    })
    assert.equal(denied.json().allowed, false)

    const allowed = await app.inject({
      method: 'POST',
      url: '/scope/check',
      payload: { target: 'unique-task-host.example', task_id: taskId },
    })
    assert.equal(allowed.json().allowed, true)
    assert.equal(allowed.json().matched, 'unique-task-host.example')
  })

  it('rejects thorough issue without verdict=confirmed', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        mode: 'thorough',
        objective: 'find xss',
        allowlist: ['*.lab.internal'],
      },
    })
    assert.equal(create.statusCode, 201)
    const taskId = create.json().id as string

    const res = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'maybe xss',
        severity: 'high',
        verdict: 'unverified',
        host: 'app.lab.internal',
      },
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error, /verdict=confirmed/)
  })

  it('allows thorough issue with verdict=confirmed', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        mode: 'thorough',
        objective: 'confirm xss',
        allowlist: ['*.lab.internal'],
      },
    })
    const taskId = create.json().id as string

    const res = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'confirmed xss',
        severity: 'high',
        verdict: 'confirmed',
        host: 'app.lab.internal',
        evidence_paths: ['/workspace/proof.png'],
        reproduction: 'open /#/search',
      },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.status, 'confirmed')
    assert.equal(body.verdict, 'confirmed')
    assert.ok(body.id)
  })

  it('allows fast mode to file unverified issues', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        mode: 'fast',
        objective: 'quick look',
        allowlist: ['juice-shop'],
      },
    })
    const taskId = create.json().id as string

    const res = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'possible finding',
        severity: 'medium',
        verdict: 'suspected',
        host: 'juice-shop',
      },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().status, 'unverified')
  })

  it('PUT /tasks/:id/memory merges arrays (replace provided keys only)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        id: randomUUID(),
        mode: 'fast',
        objective: 'memory merge',
        allowlist: ['localhost'],
      },
    })
    assert.equal(create.statusCode, 201)
    const taskId = create.json().id as string

    const seed = await app.inject({
      method: 'PUT',
      url: `/tasks/${taskId}/memory`,
      payload: {
        insights: ['i1'],
        facts: ['f1'],
        todos: ['t1'],
        files: ['a.txt'],
      },
    })
    assert.equal(seed.statusCode, 200)

    const merged = await app.inject({
      method: 'PUT',
      url: `/tasks/${taskId}/memory`,
      payload: {
        insights: ['i2'],
        todos: ['t2', 't3'],
      },
    })
    assert.equal(merged.statusCode, 200)
    const body = merged.json()
    assert.deepEqual(body.insights, ['i2'])
    assert.deepEqual(body.facts, ['f1'])
    assert.deepEqual(body.todos, ['t2', 't3'])
    assert.deepEqual(body.files, ['a.txt'])

    const got = await app.inject({ method: 'GET', url: `/tasks/${taskId}/memory` })
    assert.deepEqual(got.json().facts, ['f1'])
    assert.deepEqual(got.json().insights, ['i2'])
  })

  it('GET /issues filters by host and status', async () => {
    const host = `filter-host-${randomUUID().slice(0, 8)}.lab.internal`
    const create = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { mode: 'fast', objective: 'filter', allowlist: ['*.lab.internal'] },
    })
    const taskId = create.json().id as string

    await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'one',
        severity: 'low',
        host,
        verdict: 'suspected',
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/issues?host=${encodeURIComponent(host)}&status=unverified`,
    })
    assert.equal(res.statusCode, 200)
    const issues = res.json().issues as Array<{ host: string }>
    assert.ok(issues.length >= 1)
    assert.ok(issues.every((i) => i.host === host))
  })

  it('PATCH /issues/:id updates status', async () => {
    const createTask = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { mode: 'fast', objective: 'patch', allowlist: ['localhost'] },
    })
    const taskId = createTask.json().id as string
    const created = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'to patch',
        severity: 'info',
        verdict: 'suspected',
      },
    })
    const issueId = created.json().id as string

    const patched = await app.inject({
      method: 'PATCH',
      url: `/issues/${issueId}`,
      payload: { status: 'false_positive' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().status, 'false_positive')
  })

  it('rejects PATCH status=confirmed without verdict=confirmed', async () => {
    const createTask = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { mode: 'fast', objective: 'patch-confirmed', allowlist: ['localhost'] },
    })
    const taskId = createTask.json().id as string
    const created = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: {
        task_id: taskId,
        title: 'unconfirmed finding',
        severity: 'high',
        verdict: 'suspected',
      },
    })
    const issueId = created.json().id as string

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/issues/${issueId}`,
      payload: { status: 'confirmed' },
    })
    assert.equal(rejected.statusCode, 400)
    assert.match(rejected.json().error, /verdict=confirmed/)
  })
})
