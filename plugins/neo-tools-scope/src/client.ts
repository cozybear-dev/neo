import { normalizeScopeHost } from './host.ts'

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ status: number; text(): Promise<string> }>

export type EnvMap = Record<string, string | undefined>

export type ClientOptions = {
  controlUrl?: string
  taskId?: string
  fetch?: FetchLike
  env?: EnvMap
  signal?: AbortSignal
  agent?: { id?: string }
}

export type ScopeCheckResult = {
  allowed: boolean
  matched: string
  reason: string
}

export class ScopeDeniedError extends Error {
  readonly result: ScopeCheckResult
  constructor(target: string, result: ScopeCheckResult) {
    super(`target not in scope (${target}): ${result.reason}`)
    this.name = 'ScopeDeniedError'
    this.result = result
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

export function taskIdFromSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const m = sessionId.match(UUID_EXTRACT_RE)
  return m ? m[0].toLowerCase() : undefined
}

export function controlUrl(env: EnvMap = process.env): string {
  return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
}

export function resolveTaskId(
  arg: string | undefined,
  env: EnvMap = process.env,
  agent?: { id?: string },
): string | undefined {
  const candidates = [arg, env.NEO_TASK_ID, taskIdFromSession(agent?.id)]
  return candidates.map((v) => v?.trim()).find((v) => v && UUID_RE.test(v))
}

async function readJson(
  fetchImpl: FetchLike,
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  if (!text) return { status: res.status, body: null }
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: { error: text } }
  }
}

function asScopeResult(body: unknown): ScopeCheckResult {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    allowed: obj.allowed === true,
    matched: typeof obj.matched === 'string' ? obj.matched : '',
    reason: typeof obj.reason === 'string' ? obj.reason : 'unknown scope result',
  }
}

async function checkOne(
  target: string,
  extraHosts: string[] | undefined,
  opts: ClientOptions,
): Promise<ScopeCheckResult> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const taskId = resolveTaskId(opts.taskId, env, opts.agent)
  const payload: Record<string, unknown> = { target }
  if (extraHosts && extraHosts.length > 0) payload.extra_hosts = extraHosts
  if (taskId) payload.task_id = taskId

  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/scope/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })

  if (status < 200 || status >= 300) {
    const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    throw new Error(`scope check failed (${status}): ${typeof err === 'string' ? err : 'http error'}`)
  }

  return asScopeResult(body)
}

export async function checkScope(
  args: { target: string; extra_hosts?: string[]; task_id?: string },
  opts: ClientOptions = {},
): Promise<ScopeCheckResult> {
  const target = normalizeScopeHost(args.target)
  if (!target) {
    throw new ScopeDeniedError(args.target, { allowed: false, matched: '', reason: 'empty target' })
  }

  const extra = (args.extra_hosts ?? [])
    .map((h) => normalizeScopeHost(h))
    .filter(Boolean)
  const merged: ClientOptions = { ...opts, taskId: args.task_id ?? opts.taskId }
  const primary = await checkOne(target, extra.length ? extra : undefined, merged)
  if (!primary.allowed) throw new ScopeDeniedError(target, primary)

  for (const host of extra) {
    const result = await checkOne(host, undefined, merged)
    if (!result.allowed) throw new ScopeDeniedError(host, result)
  }

  return primary
}
