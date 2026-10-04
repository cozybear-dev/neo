import { parse } from 'yaml'
import { readFile, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

/** Only this compose/docker network is allowed for lab deploys. */
export const ALLOWED_NETWORK = 'targets'

export type EnvMap = Record<string, string | undefined>

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal; env?: EnvMap; cwd?: string },
) => Promise<ExecResult>

export type FsLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  appendFile(path: string, data: string): Promise<void>
  rm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
}

export type ClientOptions = {
  spawn?: SpawnFn
  fs?: FsLike
  env?: EnvMap
  signal?: AbortSignal
  now?: () => Date
  randomId?: () => string
}

export type DeploySource = 'git' | 'image' | 'compose'

export type DeployUpArgs = {
  source: DeploySource
  ref: string
  /** Compose/docker network. Must be `targets` (default). */
  network?: string
  id?: string
  port?: number
  service?: string
}

export type DeployUpResult = {
  id: string
  project: string
  network: string
  baseUrl: string
  logPath: string
}

export type DeployDownArgs = {
  id: string
}

export type DeployDownResult = {
  id: string
  project: string
  ok: true
}

export class DeployNetworkError extends Error {
  readonly network: string
  constructor(network: string) {
    super(
      `deploy refuses network '${network}'; only '${ALLOWED_NETWORK}' is allowed`,
    )
    this.name = 'DeployNetworkError'
    this.network = network
  }
}

export { redactSecrets, renderSafe } from '../../neo-runtime/redact.mjs'

export function composeProjectName(id: string): string {
  const clean = id.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(clean))
    throw new Error('invalid deployment id')
  return `neo-target-${clean}`
}

/** Hard-fail unless the requested compose network is exactly `targets`. */
export function assertAllowedNetwork(
  network: string | undefined | null,
): string {
  const n = String(network ?? ALLOWED_NETWORK).trim()
  if (n !== ALLOWED_NETWORK) {
    throw new DeployNetworkError(n || '(empty)')
  }
  return n
}

/** Docker engine name for the external targets network (compose sets name: neo_targets). */
export function targetsNetworkName(env: EnvMap = process.env): string {
  const value = env.NEO_TARGETS_NETWORK?.trim()
  return value || 'neo_targets'
}

export function newDeployId(): string {
  return randomBytes(4).toString('hex')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

async function broker(
  path: string,
  body: Record<string, unknown>,
  opts: ClientOptions,
): Promise<any> {
  const env = opts.env ?? process.env
  if (!env.NEO_TASK_ID || !env.NEO_TASK_TOKEN)
    throw new Error('task identity and capability required')
  const response = await fetch(
    `${env.NEO_BROKER_URL || 'http://broker:8091'}${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        task_id: env.NEO_TASK_ID,
        task_token: env.NEO_TASK_TOKEN,
      }),
      signal: opts.signal,
    },
  )
  const result = (await response.json()) as { error?: string }
  if (!response.ok)
    throw new Error(
      result.error || 'broker operation failed; outcome unknown, do not retry',
    )
  return result
}
export async function deployUp(
  args: DeployUpArgs,
  opts: ClientOptions = {},
): Promise<DeployUpResult> {
  throwIfAborted(opts.signal)
  assertAllowedNetwork(args.network)
  const id = args.id || (opts.randomId ?? newDeployId)()
  composeProjectName(id)
  if (args.source === 'git')
    throw new Error(
      'git builds unavailable: untrusted build contexts are not supported',
    )
  if (!args.port) throw new Error('explicit endpoint port required')
  let spec: unknown
  if (args.source === 'image') spec = { services: { app: { image: args.ref } } }
  else {
    // Supported input is concrete JSON Compose, avoiding includes, interpolation and host paths.
    const env = opts.env ?? process.env
    const { resolve, sep } = await import('node:path')
    const root = resolve(
      env.NEO_WORKSPACE || '/workspace',
      'tasks',
      env.NEO_TASK_ID || '',
    )
    const file = resolve(root, args.ref)
    if (!file.startsWith(root + sep))
      throw new Error('Compose path must be task owned')
    const actualRoot = await realpath(root)
    const actualFile = await realpath(file)
    if (!actualFile.startsWith(actualRoot + sep))
      throw new Error('Compose symlink escapes task root')
    spec = parse(await readFile(actualFile, 'utf8'), { maxAliasCount: 0 })
  }
  return broker(
    '/deploy/up',
    { id, spec, port: args.port, service: args.service },
    opts,
  )
}
export async function deployDown(
  args: DeployDownArgs,
  opts: ClientOptions = {},
): Promise<DeployDownResult> {
  composeProjectName(args.id)
  return broker('/deploy/down', { id: args.id }, opts)
}
