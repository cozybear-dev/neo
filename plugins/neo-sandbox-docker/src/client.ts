import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'

export type EnvMap = Record<string, string | undefined>

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type DockerExecSpec = {
  cmd: string[]
  cwd: string
  env: Record<string, string>
}

export type DockerLike = {
  exec(container: string, spec: DockerExecSpec, signal?: AbortSignal): Promise<ExecResult>
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal; env?: EnvMap },
) => Promise<ExecResult>

export type DockerEngineFn = (opts: {
  method: string
  path: string
  body?: string
  signal?: AbortSignal
}) => Promise<{ status: number; body: Buffer }>

export type ClientOptions = {
  container?: string
  docker?: DockerLike
  spawn?: SpawnFn
  engine?: DockerEngineFn
  socketPath?: string
  env?: EnvMap
  signal?: AbortSignal
}

export const DEFAULT_SANDBOX_CONTAINER = 'neo-sandbox-1'
export const DEFAULT_CWD = '/workspace'
const DOCKER_API = '/v1.41'

export function sandboxContainer(env: EnvMap = process.env): string {
  const value = env.SANDBOX_CONTAINER?.trim()
  return value || DEFAULT_SANDBOX_CONTAINER
}

export function dockerSocketPath(env: EnvMap = process.env): string {
  const host = env.DOCKER_HOST
  if (!host || host.startsWith('unix://')) {
    return (host ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '')
  }
  throw new Error(`unsupported DOCKER_HOST: ${host}`)
}

export function redactSecrets(value: unknown): unknown {
  const secretKey = /token|secret|authorization|api[_-]?key|private|password|passwd|credential/i
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = secretKey.test(k) ? '[redacted]' : walk(v)
      }
      return out
    }
    return input
  }
  return walk(value)
}

export function renderSafe(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(redactSecrets(value)) }]
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

export function dockerExecArgs(
  container: string,
  spec: DockerExecSpec,
): { command: string; args: string[] } {
  const args = ['exec', '-w', spec.cwd]
  for (const [key, value] of Object.entries(spec.env)) {
    args.push('-e', `${key}=${value}`)
  }
  args.push(container, ...spec.cmd)
  return { command: 'docker', args }
}

export function decodeDockerMux(buf: Buffer): { stdout: string; stderr: string } {
  const view = buf
  if (view.length < 8 || (view[0] !== 1 && view[0] !== 2 && view[0] !== 0)) {
    return { stdout: view.toString('utf8'), stderr: '' }
  }
  let offset = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  while (offset + 8 <= view.length) {
    const type = view[offset]
    const size = view.readUInt32BE(offset + 4)
    offset += 8
    if (size < 0 || offset + size > view.length) break
    const slice = view.subarray(offset, offset + size)
    offset += size
    if (type === 1) stdout.push(slice)
    else if (type === 2) stderr.push(slice)
  }
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

export async function spawnCollect(
  command: string,
  args: string[],
  opts: { signal?: AbortSignal; env?: EnvMap } = {},
): Promise<ExecResult> {
  throwIfAborted(opts.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      signal: opts.signal,
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 1,
      })
    })
  })
}

export function dockerEngineRequest(opts: {
  socketPath: string
  method: string
  path: string
  body?: string
  signal?: AbortSignal
}): Promise<{ status: number; body: Buffer }> {
  throwIfAborted(opts.signal)
  const payload = opts.body ?? ''
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: opts.socketPath,
        path: opts.path,
        method: opts.method,
        headers: {
          'Content-Type': 'application/json',
          Host: 'docker',
          'Content-Length': Buffer.byteLength(payload),
        },
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function httpExec(
  container: string,
  spec: DockerExecSpec,
  opts: ClientOptions,
): Promise<ExecResult> {
  const env = opts.env ?? process.env
  const engine = opts.engine ?? ((req) => dockerEngineRequest({
    socketPath: opts.socketPath ?? dockerSocketPath(env),
    method: req.method,
    path: req.path,
    body: req.body,
    signal: req.signal,
  }))
  const envList = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)
  const create = await engine({
    method: 'POST',
    path: `${DOCKER_API}/containers/${encodeURIComponent(container)}/exec`,
    body: JSON.stringify({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: spec.cmd,
      WorkingDir: spec.cwd,
      Env: envList,
    }),
    signal: opts.signal,
  })
  if (create.status === 404) {
    throw new Error(`sandbox container not found: ${container} (set SANDBOX_CONTAINER)`)
  }
  if (create.status < 200 || create.status >= 300) {
    throw new Error(`docker exec create failed (${create.status}): ${create.body.toString('utf8')}`)
  }
  let created: { Id?: string }
  try {
    created = JSON.parse(create.body.toString('utf8')) as { Id?: string }
  } catch {
    throw new Error('docker exec create returned invalid JSON')
  }
  const execId = created.Id
  if (!execId) throw new Error('docker exec create did not return Id')

  const start = await engine({
    method: 'POST',
    path: `${DOCKER_API}/exec/${encodeURIComponent(execId)}/start`,
    body: JSON.stringify({ Detach: false, Tty: false }),
    signal: opts.signal,
  })
  if (start.status < 200 || start.status >= 300) {
    throw new Error(`docker exec start failed (${start.status}): ${start.body.toString('utf8')}`)
  }
  const mux = decodeDockerMux(start.body)

  const inspect = await engine({
    method: 'GET',
    path: `${DOCKER_API}/exec/${encodeURIComponent(execId)}/json`,
    signal: opts.signal,
  })
  let exitCode = 1
  if (inspect.status >= 200 && inspect.status < 300) {
    try {
      const info = JSON.parse(inspect.body.toString('utf8')) as { ExitCode?: number }
      if (typeof info.ExitCode === 'number') exitCode = info.ExitCode
    } catch {
      exitCode = 1
    }
  }
  return { stdout: mux.stdout, stderr: mux.stderr, exitCode }
}

async function cliExec(
  container: string,
  spec: DockerExecSpec,
  opts: ClientOptions,
): Promise<ExecResult> {
  const spawnFn = opts.spawn ?? spawnCollect
  const { command, args } = dockerExecArgs(container, spec)
  return spawnFn(command, args, { signal: opts.signal })
}

export function createDocker(opts: ClientOptions = {}): DockerLike {
  return {
    async exec(container, spec, signal) {
      const merged: ClientOptions = { ...opts, signal: signal ?? opts.signal }
      if (opts.engine) return httpExec(container, spec, merged)
      if (opts.spawn) return cliExec(container, spec, merged)
      try {
        return await httpExec(container, spec, merged)
      } catch (err) {
        if (opts.signal?.aborted) throw err
        return cliExec(container, spec, merged)
      }
    },
  }
}

export async function execInSandbox(
  args: { command: string; cwd?: string; env?: Record<string, string> },
  opts: ClientOptions = {},
): Promise<ExecResult> {
  throwIfAborted(opts.signal)
  const command = args.command.trim()
  if (!command) throw new Error('command is required')
  const env = opts.env ?? process.env
  const container = opts.container ?? sandboxContainer(env)
  const cwd = args.cwd && args.cwd.trim() ? args.cwd.trim() : DEFAULT_CWD
  const extraEnv = args.env ?? {}
  const spec: DockerExecSpec = {
    cmd: ['bash', '-lc', command],
    cwd,
    env: extraEnv,
  }
  const docker = opts.docker ?? createDocker(opts)
  return docker.exec(container, spec, opts.signal)
}
