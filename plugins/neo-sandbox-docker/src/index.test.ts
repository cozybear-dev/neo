import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createDocker,
  decodeDockerMux,
  dockerExecArgs,
  execInSandbox,
  redactSecrets,
  renderSafe,
  sandboxContainer,
  type DockerEngineFn,
  type DockerLike,
  type SpawnFn,
} from './client.ts'

function muxFrame(type: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = type
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

describe('sandbox container', () => {
  it('defaults to neo-sandbox-1', () => {
    assert.equal(sandboxContainer({}), 'neo-sandbox-1')
  })

  it('uses SANDBOX_CONTAINER', () => {
    assert.equal(sandboxContainer({ SANDBOX_CONTAINER: 'sandbox' }), 'sandbox')
  })
})

describe('execInSandbox', () => {
  it('docker-execs bash -lc in /workspace', async () => {
    let got: { container: string; spec: { cmd: string[]; cwd: string; env: Record<string, string> } } | undefined
    const docker: DockerLike = {
      async exec(container, spec) {
        got = { container, spec }
        return { stdout: 'hi\n', stderr: '', exitCode: 0 }
      },
    }
    const result = await execInSandbox(
      { command: 'echo hi' },
      { docker, env: { SANDBOX_CONTAINER: 'neo-sandbox-1' } },
    )
    assert.deepEqual(result, { stdout: 'hi\n', stderr: '', exitCode: 0 })
    assert.equal(got?.container, 'neo-sandbox-1')
    assert.deepEqual(got?.spec, {
      cmd: ['bash', '-lc', 'echo hi'],
      cwd: '/workspace',
      env: {},
    })
  })

  it('honors cwd override and extra env without echoing secrets in render', async () => {
    let specEnv: Record<string, string> | undefined
    const docker: DockerLike = {
      async exec(_c, spec) {
        specEnv = spec.env
        return { stdout: 'ok', stderr: '', exitCode: 0 }
      },
    }
    await execInSandbox(
      { command: 'true', cwd: '/tmp', env: { GITHUB_TOKEN: 'ghp_secret', PATH: '/usr/bin' } },
      { docker, env: {} },
    )
    assert.equal(specEnv?.GITHUB_TOKEN, 'ghp_secret')
    const rendered = renderSafe({}, { stdout: 'ok', env: specEnv })
    assert.match(rendered[0]!.text, /\[redacted\]/)
    assert.doesNotMatch(rendered[0]!.text, /ghp_secret/)
  })

  it('honors exec.signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const docker: DockerLike = {
      async exec(_c, _s, signal) {
        if (signal?.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          throw err
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    await assert.rejects(
      () => execInSandbox({ command: 'sleep 9' }, { docker, signal: ac.signal }),
      (err: unknown) => {
        assert.equal((err as Error).name, 'AbortError')
        return true
      },
    )
  })

  it('throws on empty command', async () => {
    await assert.rejects(() => execInSandbox({ command: '  ' }, { docker: { async exec() { return { stdout: '', stderr: '', exitCode: 0 } } } }), /required/)
  })

  it('builds docker CLI argv with -w /workspace', () => {
    const { command, args } = dockerExecArgs('neo-sandbox-1', {
      cmd: ['bash', '-lc', 'echo hi'],
      cwd: '/workspace',
      env: { FOO: 'bar' },
    })
    assert.equal(command, 'docker')
    assert.deepEqual(args, [
      'exec', '-w', '/workspace', '-e', 'FOO=bar', 'neo-sandbox-1', 'bash', '-lc', 'echo hi',
    ])
  })

  it('CLI docker uses spawn with signal', async () => {
    const ac = new AbortController()
    let got: { command: string; args: string[]; signal?: AbortSignal } | undefined
    const spawnFn: SpawnFn = async (command, args, opts) => {
      got = { command, args, signal: opts?.signal }
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    }
    const result = await execInSandbox(
      { command: 'uname -a' },
      { spawn: spawnFn, env: { SANDBOX_CONTAINER: 'sandbox' }, signal: ac.signal },
    )
    assert.equal(result.exitCode, 0)
    assert.equal(got?.command, 'docker')
    assert.equal(got?.args[0], 'exec')
    assert.equal(got?.args[2], '/workspace')
    assert.ok(got?.args.includes('sandbox'))
    assert.equal(got?.signal, ac.signal)
  })
})

describe('docker engine HTTP', () => {
  it('creates, starts, and inspects an exec', async () => {
    const calls: Array<{ method: string; path: string; body?: string }> = []
    const engine: DockerEngineFn = async (req) => {
      calls.push({ method: req.method, path: req.path, body: req.body })
      if (req.path.endsWith('/exec') && req.method === 'POST') {
        return { status: 201, body: Buffer.from(JSON.stringify({ Id: 'ex1' })) }
      }
      if (req.path.includes('/exec/ex1/start')) {
        return { status: 200, body: Buffer.concat([muxFrame(1, 'hello\n'), muxFrame(2, '')]) }
      }
      if (req.path.includes('/exec/ex1/json')) {
        return { status: 200, body: Buffer.from(JSON.stringify({ ExitCode: 0, Running: false })) }
      }
      return { status: 404, body: Buffer.from('no') }
    }
    const docker = createDocker({ engine, env: {} })
    const result = await execInSandbox({ command: 'echo hello' }, { docker, env: {} })
    assert.deepEqual(result, { stdout: 'hello\n', stderr: '', exitCode: 0 })
    assert.match(calls[0]!.path, /\/containers\/neo-sandbox-1\/exec/)
    const created = JSON.parse(calls[0]!.body ?? '{}') as { WorkingDir: string; Cmd: string[] }
    assert.equal(created.WorkingDir, '/workspace')
    assert.deepEqual(created.Cmd, ['bash', '-lc', 'echo hello'])
  })

  it('throws a clear error when the container is missing', async () => {
    const engine: DockerEngineFn = async () => ({ status: 404, body: Buffer.from('no such container') })
    await assert.rejects(
      () => execInSandbox({ command: 'true' }, { docker: createDocker({ engine }), env: { SANDBOX_CONTAINER: 'missing' } }),
      /SANDBOX_CONTAINER/,
    )
  })
})

describe('decodeDockerMux', () => {
  it('splits stdout and stderr frames', () => {
    const buf = Buffer.concat([muxFrame(1, 'out'), muxFrame(2, 'err')])
    assert.deepEqual(decodeDockerMux(buf), { stdout: 'out', stderr: 'err' })
  })
})

describe('redactSecrets', () => {
  it('redacts secret-shaped keys', () => {
    const redacted = redactSecrets({ API_KEY: 'x', nested: { password: 'y' }, ok: 1 }) as {
      API_KEY: string
      nested: { password: string }
      ok: number
    }
    assert.equal(redacted.API_KEY, '[redacted]')
    assert.equal(redacted.nested.password, '[redacted]')
    assert.equal(redacted.ok, 1)
  })
})
