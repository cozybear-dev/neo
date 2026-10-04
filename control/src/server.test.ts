import { mkdtemp, cp, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp, checkScope } from './server.js'
import { createPool, migrate } from './db.js'
const admin = 'operator-fixture-token-32characters',
  broker = 'broker-fixture-token-32characters'
const databaseUrl = process.env.TEST_DATABASE_URL
const adminHeaders = { authorization: `Bearer ${admin}` }
test('scope is task-granted, ceiling bounded, deny preferred and CIDR aware', () => {
  assert.equal(
    checkScope({
      target: 'a.example.com',
      envAllowlist: ['*.example.com'],
      taskAllowlist: ['*.example.com'],
    }).allowed,
    true,
  )
  assert.deepEqual(
    checkScope({
      target: 'other.test',
      envAllowlist: ['other.test'],
      taskAllowlist: [],
    }),
    {
      allowed: false,
      matched: '',
      reason: 'not in the task allowlist',
    },
  )
  assert.equal(
    checkScope({
      target: 'a.example.com',
      envAllowlist: ['other.test'],
      taskAllowlist: ['a.example.com'],
    }).reason,
    'outside NEO_ALLOWLIST',
  )
  assert.equal(
    checkScope({
      target: '10.0.1.2',
      envAllowlist: [],
      taskAllowlist: ['10.0.0.0/16'],
    }).allowed,
    true,
  )
  assert.equal(
    checkScope({
      target: '10.0.1.2',
      envAllowlist: [],
      taskAllowlist: ['10.0.0.0/16'],
      taskDenylist: ['10.0.1.0/24'],
    }).allowed,
    false,
  )
})
test('chat session copies NEO_ALLOWLIST and NEO_MODE_DEFAULT', async () => {
  assert.ok(databaseUrl, 'TEST_DATABASE_URL required')
  const pool = createPool(databaseUrl!)
  const opener = 'session-opener-token-32characters'
  const app = await buildApp({
    pool,
    adminToken: admin,
    brokerToken: broker,
    logger: false,
    allowlistEnv: 'huntandhackett.com,*.huntandhackett.com',
    sessionOpenToken: opener,
    modeDefault: 'thorough',
  })
  const empty = await buildApp({
    pool,
    adminToken: admin,
    brokerToken: broker,
    logger: false,
    allowlistEnv: '',
    sessionOpenToken: opener,
    modeDefault: 'fast',
  })
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${admin}` },
      payload: { objective: 'pentest huntandhackett.com' },
    })
    assert.equal(denied.statusCode, 403)
    const extra = await app.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${opener}` },
      payload: {
        objective: 'pentest huntandhackett.com',
        allowlist: ['evil.test'],
      },
    })
    assert.equal(extra.statusCode, 400)
    const blank = await app.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${opener}` },
      payload: { objective: ' ' },
    })
    assert.equal(blank.statusCode, 400)
    const opened = await app.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${opener}` },
      payload: { objective: 'pentest huntandhackett.com' },
    })
    assert.equal(opened.statusCode, 201)
    const body = opened.json()
    assert.equal(body.mode, 'thorough')
    assert.equal(body.objective, 'pentest huntandhackett.com')
    assert.deepEqual(body.allowlist, [
      'huntandhackett.com',
      '*.huntandhackett.com',
    ])
    assert.equal(body.denylist.length, 0)
    assert.equal(typeof body.task_token, 'string')
    const missing = await empty.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${opener}` },
      payload: { objective: 'pentest huntandhackett.com' },
    })
    assert.equal(missing.statusCode, 400)
    assert.match(missing.json().error, /NEO_ALLOWLIST is empty/)
  } finally {
    await app.close()
    await empty.close()
    await pool.end()
  }
})
test('migrate reports a rejected database password', async () => {
  const error = Object.assign(new Error('password authentication failed'), {
    code: '28P01',
  })
  await assert.rejects(
    () =>
      buildApp({
        pool: {
          connect: async () => {
            throw error
          },
        } as any,
        adminToken: admin,
        brokerToken: broker,
        logger: false,
      }),
    /pgdata volume still has a different role password/,
  )
})
test('child registration rechecks a parent finished after its initial identity lookup', async () => {
  assert.ok(databaseUrl, 'TEST_DATABASE_URL required')
  const pool = createPool(databaseUrl!)
  await migrate(pool)
  let afterLookup: (() => Promise<void>) | undefined
  const wrappedPool = {
    connect: pool.connect.bind(pool),
    query: async (...args: any[]) => {
      const result = await (pool.query as any)(...args)
      if (
        afterLookup &&
        String(args[0]).startsWith('SELECT * FROM task_runs')
      ) {
        const callback = afterLookup
        afterLookup = undefined
        await callback()
      }
      return result
    },
  }
  const app = await buildApp({
    pool: wrappedPool as any,
    adminToken: admin,
    brokerToken: broker,
    logger: false,
  })
  let taskId: string | undefined
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: adminHeaders,
      payload: { mode: 'fast', objective: 'race regression', allowlist: [] },
    })
    const task = created.json()
    taskId = task.id
    const headers = { authorization: `Bearer ${task.task_token}` }
    const registered = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers,
      payload: { role: 'orchestrator' },
    })
    const parent = registered.json()
    const parentHeaders = { ...headers, 'x-neo-run-token': parent.run_token }
    afterLookup = async () => {
      const finished = await app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/runs/${parent.id}/finish`,
        headers: parentHeaders,
        payload: { status: 'completed', outcome: {} },
      })
      assert.equal(finished.statusCode, 200)
    }
    const child = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/runs`,
      headers: parentHeaders,
      payload: { role: 'explore', parent_id: parent.id },
    })
    assert.equal(child.statusCode, 409)
    assert.match(child.json().error, /parent run is terminal/)
    assert.equal(
      (
        await pool.query('SELECT id FROM task_runs WHERE parent_id=$1', [
          parent.id,
        ])
      ).rowCount,
      0,
    )
  } finally {
    if (taskId)
      await app.inject({
        method: 'DELETE',
        url: `/tasks/${taskId}`,
        headers: adminHeaders,
      })
    await app.close()
    await pool.end()
  }
})
test('authoritative task, concurrent revisions, approval and independent verification lifecycle', async () => {
  assert.ok(
    databaseUrl,
    'TEST_DATABASE_URL required; use explicitly named offline test for no DB',
  )
  const pool = createPool(databaseUrl!)
  await Promise.all([migrate(pool), migrate(pool)])
  const copy = await mkdtemp(join(tmpdir(), 'neo-migration-checksum-'))
  await cp(new URL('../migrations', import.meta.url), copy, {
    recursive: true,
  })
  await appendFile(join(copy, '001_init.sql'), '\n-- injected change\n')
  await assert.rejects(() => migrate(pool, copy), /checksum mismatch/)
  await rm(copy, { recursive: true, force: true })
  const app = await buildApp({
    pool,
    adminToken: admin,
    brokerToken: broker,
    logger: false,
  })
  const call = async (
    method: any,
    url: string,
    payload?: any,
    headers: any = adminHeaders,
  ) => {
    const res = await app.inject({ method, url, payload, headers })
    return { status: res.statusCode, body: res.json() }
  }
  try {
    assert.equal(
      (
        await call(
          'POST',
          '/tasks',
          { mode: 'fast', objective: 'x', allowlist: ['example.test'] },
          {},
        )
      ).status,
      401,
    )
    assert.equal(
      (
        await call('POST', '/tasks', {
          mode: 'fast',
          objective: 'x',
          allowlist: [{}],
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await call('POST', '/tasks', {
          mode: 'fast',
          objective: 'x',
          allowlist: ['foo..test'],
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await call('POST', '/tasks', {
          id: 'bad',
          mode: 'fast',
          objective: 'x',
          allowlist: [],
        })
      ).status,
      400,
    )
    const created = await call('POST', '/tasks', {
      mode: 'thorough',
      objective: 'fixture',
      allowlist: ['example.test'],
    })
    assert.equal(created.status, 201)
    const id = created.body.id
    const headers = { authorization: 'Bearer ' + created.body.task_token }
    assert.equal(
      (
        await call(
          'POST',
          '/scope/check',
          { task_id: randomUUID(), target: 'example.test' },
          headers,
        )
      ).status,
      404,
    )
    const other = await call('POST', '/tasks', {
      mode: 'fast',
      objective: 'other',
      allowlist: [],
    })
    assert.equal(
      (await call('GET', `/tasks/${other.body.id}`, undefined, headers)).status,
      403,
    )
    const results = await Promise.all([
      call(
        'PUT',
        `/tasks/${id}/memory`,
        { revision: 0, facts: ['A'] },
        headers,
      ),
      call(
        'PUT',
        `/tasks/${id}/memory`,
        { revision: 0, todos: ['B'] },
        headers,
      ),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    const loser =
      results[0].status === 409 ? { facts: ['A'] } : { todos: ['B'] }
    assert.equal(
      (
        await call(
          'PUT',
          `/tasks/${id}/memory`,
          { revision: 1, ...loser },
          headers,
        )
      ).status,
      200,
    )
    const memory = (
      await call('GET', `/tasks/${id}/memory`, undefined, headers)
    ).body
    assert.deepEqual(memory.facts, ['A'])
    assert.deepEqual(memory.todos, ['B'])
    assert.equal(
      (
        await call(
          'PATCH',
          `/tasks/${id}`,
          { revision: 0, allowlist: ['evil.test'] },
          headers,
        )
      ).status,
      400,
    )
    assert.equal(
      (
        await call(
          'PATCH',
          `/tasks/${id}`,
          { revision: 0, mode: 'fast' },
          headers,
        )
      ).status,
      403,
    )
    const root = await call(
      'POST',
      `/tasks/${id}/runs`,
      { role: 'orchestrator' },
      headers,
    )
    const rootHeaders = { ...headers, 'x-neo-run-token': root.body.run_token }
    assert.equal(
      (
        await call(
          'POST',
          `/tasks/${id}/runs`,
          { role: 'specialist', parent_id: root.body.id },
          rootHeaders,
        )
      ).status,
      403,
    )
    const plan = await call(
      'POST',
      `/tasks/${id}/plan`,
      { revision: 0, plan: 'approved fixture' },
      headers,
    )
    assert.equal(plan.status, 200)
    assert.equal(
      (
        await call(
          'POST',
          `/tasks/${id}/approvals`,
          { revision: 1, plan_revision: 1 },
          headers,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await call('POST', `/tasks/${id}/approvals`, {
          revision: 1,
          plan_revision: 1,
        })
      ).status,
      200,
    )
    const specialist = await call(
      'POST',
      `/tasks/${id}/runs`,
      { role: 'specialist', parent_id: root.body.id },
      rootHeaders,
    )
    const finderHeaders = {
      ...headers,
      'x-neo-run-token': specialist.body.run_token,
    }
    const issue = await call(
      'POST',
      '/issues',
      { task_id: id, title: 'finding', severity: 'high' },
      finderHeaders,
    )
    assert.equal(issue.status, 201)
    assert.equal(
      (
        await call(
          'PATCH',
          `/issues/${issue.body.id}`,
          { revision: 0, status: 'confirmed' },
          finderHeaders,
        )
      ).status,
      403,
    )
    const judge = await call(
      'POST',
      `/tasks/${id}/runs`,
      { role: 'judge', parent_id: root.body.id },
      rootHeaders,
    )
    const verifier = await call(
      'POST',
      `/tasks/${id}/runs`,
      { role: 'verifier', parent_id: judge.body.id },
      { ...headers, 'x-neo-run-token': judge.body.run_token },
    )
    const proof = await call(
      'POST',
      `/issues/${issue.body.id}/verifications`,
      { revision: 0, outcome: 'confirmed', evidence_paths: ['evidence.txt'] },
      { ...headers, 'x-neo-run-token': verifier.body.run_token },
    )
    assert.equal(proof.status, 200)
    assert.equal(
      (
        await call(
          'PATCH',
          `/issues/${issue.body.id}`,
          {
            revision: 0,
            status: 'confirmed',
            verification_id: proof.body.id,
            title: 'changed',
          },
          finderHeaders,
        )
      ).status,
      409,
    )
    const updated = await call(
      'PATCH',
      `/issues/${issue.body.id}`,
      {
        revision: 0,
        status: 'confirmed',
        verification_id: proof.body.id,
        comment: 'verified fixture',
      },
      finderHeaders,
    )
    assert.equal(updated.status, 200)
    assert.equal(updated.body.status, 'confirmed')
    const history = await call(
      'GET',
      `/issues/${issue.body.id}/history`,
      undefined,
      headers,
    )
    assert.equal(history.body.history[0].change.comment, 'verified fixture')
    const changed = await call(
      'PATCH',
      `/issues/${issue.body.id}`,
      { revision: 1, title: 'new candidate' },
      finderHeaders,
    )
    assert.equal(changed.body.status, 'unverified')
    assert.equal(
      (
        await call(
          'PATCH',
          `/issues/${issue.body.id}`,
          { revision: 2, status: 'confirmed', verification_id: proof.body.id },
          finderHeaders,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await call(
          'POST',
          '/internal/authorize',
          {
            task_id: id,
            task_token: created.body.task_token,
            capability: 'exec',
            target: 'evil.test',
          },
          { authorization: 'Bearer ' + broker },
        )
      ).status,
      403,
    )
    await call(
      'POST',
      `/tasks/${id}/plan`,
      { revision: 1, plan: 'changed' },
      headers,
    )
    assert.equal(
      (
        await call(
          'POST',
          '/internal/authorize',
          {
            task_id: id,
            task_token: created.body.task_token,
            capability: 'exec',
          },
          { authorization: 'Bearer ' + broker },
        )
      ).status,
      403,
    )
    // Revocation and completion must stop execution while permitting owned cleanup.
    const authorizeCleanup = (taskToken: string, capability = 'cleanup') =>
      call(
        'POST',
        '/internal/authorize',
        { task_id: id, task_token: taskToken, capability },
        { authorization: 'Bearer ' + broker },
      )
    assert.equal((await authorizeCleanup(created.body.task_token)).status, 200)
    const currentTask = await call('GET', `/tasks/${id}`, undefined, headers)
    assert.equal(
      (
        await call(
          'PATCH',
          `/tasks/${id}`,
          { revision: currentTask.body.revision, status: 'completed' },
          headers,
        )
      ).status,
      200,
    )
    assert.equal((await authorizeCleanup(created.body.task_token)).status, 200)
    assert.equal(
      (await authorizeCleanup(created.body.task_token, 'exec')).status,
      409,
    )
    assert.equal((await authorizeCleanup(other.body.task_token)).status, 403)
    // Roll back both task and memory when the second insert fails.
    await pool.query(
      "CREATE OR REPLACE FUNCTION fixture_memory_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture second statement failure'; END $$",
    )
    await pool.query(
      'CREATE TRIGGER fixture_memory_failure BEFORE INSERT ON task_memory FOR EACH ROW EXECUTE FUNCTION fixture_memory_failure()',
    )
    const doomed = randomUUID()
    assert.equal(
      (
        await call('POST', '/tasks', {
          id: doomed,
          mode: 'fast',
          objective: 'rollback',
          allowlist: [],
        })
      ).status,
      500,
    )
    assert.equal(
      (await pool.query('SELECT id FROM tasks WHERE id=$1', [doomed])).rowCount,
      0,
    )
    await pool.query('DROP TRIGGER fixture_memory_failure ON task_memory')
    await pool.query('DROP FUNCTION fixture_memory_failure()')
  } finally {
    await pool.end()
    assert.equal((await app.inject({ url: '/readyz' })).statusCode, 503)
    assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200)
    await app.close()
  }
})
