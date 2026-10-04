import {
  readdir,
  readFile,
  mkdir,
  open,
  lstat,
  realpath,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export type EnvMap = Record<string, string | undefined>

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  artifactRef?: string
  truncated?: boolean
}

export type DockerExecSpec = {
  cmd: string[]
  cwd: string
  env: Record<string, string>
}

export type DockerLike = {
  exec(
    container: string,
    spec: DockerExecSpec,
    signal?: AbortSignal,
  ): Promise<ExecResult>
}

export type ClientOptions = {
  container?: string
  docker?: DockerLike
  env?: EnvMap
  signal?: AbortSignal
}

export const DEFAULT_SANDBOX_CONTAINER = 'neo-sandbox-1'
export const DEFAULT_CWD = '/workspace'

export function sandboxContainer(env: EnvMap = process.env): string {
  const value = env.SANDBOX_CONTAINER?.trim()
  return value || DEFAULT_SANDBOX_CONTAINER
}

export { redactSecrets, renderSafe } from '../../neo-runtime/redact.mjs'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

export function createDocker(opts: ClientOptions = {}): DockerLike {
  return {
    async exec(_container, spec, signal) {
      const env = opts.env ?? process.env
      const task_id = env.NEO_TASK_ID,
        task_token = env.NEO_TASK_TOKEN
      if (
        !task_id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          task_id || '',
        ) ||
        !task_token
      )
        throw new Error('task identity and capability required')
      const root = resolve(env.NEO_WORKSPACE || '/workspace', 'tasks', task_id)
      const files: Array<{ path: string; body_base64: string }> = []
      let total = 0
      let visited = 0
      async function collect(dir: string, prefix = ''): Promise<void> {
        if (prefix.split('/').length > 16 || visited >= 256) return
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (++visited > 256 || files.length >= 128 || total >= 512000) return
          if (e.name.startsWith('.')) continue
          const path = prefix + e.name
          if (e.isDirectory()) await collect(resolve(dir, e.name), path + '/')
          else if (e.isFile()) {
            const handle = await open(
              resolve(dir, e.name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            )
            let b
            try {
              const stat = await handle.stat()
              if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
                continue
              b = await handle.readFile()
            } finally {
              await handle.close()
            }
            if (
              b.length <= 65536 &&
              files.length < 128 &&
              total + b.length <= 512000
            ) {
              total += b.length
              files.push({ path, body_base64: b.toString('base64') })
            }
          }
        }
      }
      await collect(root)
      const job_id = randomUUID()
      const url = env.NEO_BROKER_URL || 'http://broker:8091'
      const cancel = () => {
        void fetch(`${url}/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ task_id, task_token, job_id }),
        }).catch(() => {})
      }
      throwIfAborted(signal)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const response = await fetch(`${url}/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            task_id,
            task_token,
            job_id,
            ...spec,
            cwd: spec.cwd.startsWith(root)
              ? '/workspace' + spec.cwd.slice(root.length)
              : spec.cwd,
            files,
            network: env.NEO_EXEC_NETWORK || 'none',
          }),
        })
        const result = (await response.json()) as ExecResult & {
          error?: string
        }
        if (!response.ok)
          throw new Error(
            result.error ||
              'broker execution failed; outcome unknown, do not retry',
          )
        if (
          typeof result.stdout !== 'string' ||
          typeof result.stderr !== 'string' ||
          !Number.isInteger(result.exitCode)
        )
          throw new Error(
            'malformed broker execution result; outcome unknown, do not retry',
          )
        throwIfAborted(signal)
        for (const f of (
          result as ExecResult & {
            files?: Array<{ path: string; body_base64: string }>
          }
        ).files || []) {
          const path = resolve(root, f.path)
          if (!path.startsWith(root + sep))
            throw new Error('invalid artifact response')
          await mkdir(dirname(path), { recursive: true })
          const parent = await realpath(dirname(path))
          const actualRoot = await realpath(root)
          if (parent !== actualRoot && !parent.startsWith(actualRoot + sep))
            throw new Error('artifact parent escapes task root')
          try {
            if (!(await lstat(path)).isFile())
              throw new Error('artifact destination not regular')
          } catch (e) {
            if ((e as { code?: string }).code !== 'ENOENT') throw e
          }
          const handle = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          )
          try {
            const stat = await handle.stat()
            if (!stat.isFile() || stat.nlink !== 1)
              throw new Error('artifact destination must have no hardlinks')
            await handle.truncate(0)
            await handle.writeFile(Buffer.from(f.body_base64, 'base64'))
          } finally {
            await handle.close()
          }
        }
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(typeof result.artifactRef === 'string'
            ? { artifactRef: result.artifactRef }
            : {}),
          ...(typeof result.truncated === 'boolean'
            ? { truncated: result.truncated }
            : {}),
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
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
