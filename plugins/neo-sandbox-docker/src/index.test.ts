import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDocker, execInSandbox, redactSecrets } from './client.ts'
test('empty command and missing task capabilities fail closed', async () => {
  await assert.rejects(execInSandbox({ command: ' ' }), /required/)
  await assert.rejects(
    execInSandbox({ command: 'true' }, { env: {} }),
    /identity/,
  )
})
test('pre-cancelled command is never submitted', async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(execInSandbox({ command: 'true' }, { signal }), {
    name: 'AbortError',
  })
})
test('uncertain transport failure never falls back or retries', async () => {
  const saved = globalThis.fetch
  let count = 0
  globalThis.fetch = async () => {
    count++
    throw new Error('lost after submission')
  }
  try {
    await assert.rejects(
      createDocker({
        env: {
          NEO_TASK_ID: '00000000-0000-4000-8000-000000000001',
          NEO_TASK_TOKEN: 'token',
          NEO_WORKSPACE: '/nonexistent',
        },
      }).exec('ignored', { cmd: ['true'], cwd: '/workspace', env: {} }),
      /lost/,
    )
    assert.equal(count, 1)
  } finally {
    globalThis.fetch = saved
  }
})
test('broker cancellation explicitly terminates owned remote job', async () => {
  const saved = globalThis.fetch
  const ac = new AbortController()
  const calls: any[] = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(String(opts?.body)) })
    if (String(url).endsWith('/exec')) {
      ac.abort()
      await new Promise((r) => setTimeout(r, 5))
      return new Response(
        JSON.stringify({ stdout: '', stderr: '', exitCode: 137 }),
      )
    }
    return new Response(JSON.stringify({ terminated: true }))
  }
  try {
    await assert.rejects(
      createDocker({
        env: {
          NEO_TASK_ID: '00000000-0000-4000-8000-000000000001',
          NEO_TASK_TOKEN: 'token',
          NEO_WORKSPACE: '/nonexistent',
        },
      }).exec(
        'ignored',
        { cmd: ['true'], cwd: '/workspace', env: {} },
        ac.signal,
      ),
      { name: 'AbortError' },
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body.job_id, calls[1].body.job_id)
  } finally {
    globalThis.fetch = saved
  }
})
test('secret-shaped keys redact', () =>
  assert.deepEqual(redactSecrets({ token: 'secret' }), { token: '[redacted]' }))
