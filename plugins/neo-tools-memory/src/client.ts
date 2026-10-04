import { taskHeaders, readJson } from '../../neo-runtime/contracts.mjs'
import { ensureTaskId, type AgentRef } from './task.ts'

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
  agent?: AgentRef
}

export type MemorySnapshot = {
  revision: number
  insights: unknown[]
  facts: unknown[]
  todos: unknown[]
  files: unknown[]
}

export function controlUrl(env: EnvMap = process.env): string {
  return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
}

export async function getTask(
  opts: ClientOptions = {},
): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const id = await ensureTaskId({
    arg: opts.taskId,
    env: opts.controlUrl ? { ...env, CONTROL_URL: opts.controlUrl } : env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  const result = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/tasks/${id}`,
    { headers: taskHeaders(env, opts.agent), signal: opts.signal },
  )
  const body = result.body as Record<string, unknown> | null
  if (
    result.status !== 200 ||
    body?.id !== id ||
    !Number.isInteger(body?.revision) ||
    !Number.isInteger(body?.plan_revision)
  )
    throw new Error('invalid task response')
  return body!
}

function asMemory(body: unknown): MemorySnapshot {
  const obj =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (
    typeof obj.revision !== 'number' ||
    !['insights', 'facts', 'todos', 'files'].every((k) => Array.isArray(obj[k]))
  )
    throw new Error('invalid memory response')
  return {
    revision: obj.revision,
    insights: Array.isArray(obj.insights) ? obj.insights : [],
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    todos: Array.isArray(obj.todos) ? obj.todos : [],
    files: Array.isArray(obj.files) ? obj.files : [],
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === 'object' &&
    typeof (body as { error?: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error
  }
  return fallback
}

export async function getMemory(
  args: { task_id?: string } = {},
  opts: ClientOptions = {},
): Promise<MemorySnapshot> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const id = await ensureTaskId({
    arg: args.task_id ?? opts.taskId,
    env: opts.controlUrl ? { ...env, CONTROL_URL: opts.controlUrl } : env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  const { status, body } = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/tasks/${id}/memory`,
    {
      method: 'GET',
      headers: taskHeaders(env, opts.agent),
      signal: opts.signal,
    },
  )
  if (status < 200 || status >= 300) {
    const err =
      body && typeof body === 'object'
        ? (body as { error?: unknown }).error
        : undefined
    throw new Error(
      `memory_get failed (${status}): ${typeof err === 'string' ? err : 'http error'}`,
    )
  }
  return asMemory(body)
}

export async function updateMemory(
  args: {
    task_id?: string
    revision: number
    insights?: unknown[]
    facts?: unknown[]
    todos?: unknown[]
    files?: unknown[]
  },
  opts: ClientOptions = {},
): Promise<{ ok: true }> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const id = await ensureTaskId({
    arg: args.task_id ?? opts.taskId,
    env: opts.controlUrl ? { ...env, CONTROL_URL: opts.controlUrl } : env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  if (!Number.isInteger(args.revision) || args.revision < 0)
    throw new Error('memory revision required from memory_get')
  const payload: Record<string, unknown> = { revision: args.revision }
  if (Array.isArray(args.insights)) payload.insights = args.insights
  if (Array.isArray(args.facts)) payload.facts = args.facts
  if (Array.isArray(args.todos)) payload.todos = args.todos
  if (Array.isArray(args.files)) payload.files = args.files

  const { status, body } = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/tasks/${id}/memory`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...taskHeaders(env, opts.agent),
      },
      body: JSON.stringify(payload),
      signal: opts.signal,
    },
  )
  if (status < 200 || status >= 300) {
    const err =
      body && typeof body === 'object'
        ? (body as { error?: unknown }).error
        : undefined
    throw new Error(
      `memory_update failed (${status}): ${typeof err === 'string' ? err : 'http error'}`,
    )
  }
  asMemory(body)
  return { ok: true }
}

export async function updateTask(
  args: {
    task_id?: string
    mode?: 'fast' | 'thorough'
    revision?: number
    allowlist?: string[]
    denylist?: string[]
    status?: string
    objective?: string
  },
  opts: ClientOptions = {},
): Promise<{ ok: true }> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const id = await ensureTaskId({
    arg: args.task_id ?? opts.taskId,
    env: opts.controlUrl ? { ...env, CONTROL_URL: opts.controlUrl } : env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  if (args.mode) throw new Error('mode changes require operator authorization')
  if (args.allowlist || args.denylist)
    throw new Error('scope changes require operator authorization')
  const current = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/tasks/${id}`,
    { headers: taskHeaders(env, opts.agent), signal: opts.signal },
  )
  if (current.status !== 200) throw new Error('task revision lookup failed')
  const payload: Record<string, unknown> = {
    revision: args.revision ?? (current.body as { revision: number }).revision,
  }
  if (args.mode) payload.mode = args.mode
  if (Array.isArray(args.allowlist)) payload.allowlist = args.allowlist
  if (Array.isArray(args.denylist)) payload.denylist = args.denylist
  if (typeof args.status === 'string') payload.status = args.status
  if (typeof args.objective === 'string') payload.objective = args.objective

  const { status, body } = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/tasks/${id}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...taskHeaders(env, opts.agent),
      },
      body: JSON.stringify(payload),
      signal: opts.signal,
    },
  )
  if (status < 200 || status >= 300) {
    throw new Error(
      `task_update failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }
  if (args.mode && opts.agent) {
    opts.agent.options ??= {}
    ;(opts.agent.options as any).neoMode = args.mode
  }
  return { ok: true }
}
