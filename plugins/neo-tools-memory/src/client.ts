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
  insights: unknown[]
  facts: unknown[]
  todos: unknown[]
  files: unknown[]
}

export function controlUrl(env: EnvMap = process.env): string {
  return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
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

function asMemory(body: unknown): MemorySnapshot {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    insights: Array.isArray(obj.insights) ? obj.insights : [],
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    todos: Array.isArray(obj.todos) ? obj.todos : [],
    files: Array.isArray(obj.files) ? obj.files : [],
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
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
    env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/tasks/${id}/memory`, {
    method: 'GET',
    signal: opts.signal,
  })
  if (status < 200 || status >= 300) {
    const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    throw new Error(`memory_get failed (${status}): ${typeof err === 'string' ? err : 'http error'}`)
  }
  return asMemory(body)
}

export async function updateMemory(
  args: {
    task_id?: string
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
    env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  const payload: Record<string, unknown> = {}
  if (Array.isArray(args.insights)) payload.insights = args.insights
  if (Array.isArray(args.facts)) payload.facts = args.facts
  if (Array.isArray(args.todos)) payload.todos = args.todos
  if (Array.isArray(args.files)) payload.files = args.files

  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/tasks/${id}/memory`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  if (status < 200 || status >= 300) {
    const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    throw new Error(`memory_update failed (${status}): ${typeof err === 'string' ? err : 'http error'}`)
  }
  return { ok: true }
}

export async function updateTask(
  args: {
    task_id?: string
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
    env,
    agent: opts.agent,
    fetch: fetchImpl,
    signal: opts.signal,
  })
  const payload: Record<string, unknown> = {}
  if (Array.isArray(args.allowlist)) payload.allowlist = args.allowlist
  if (Array.isArray(args.denylist)) payload.denylist = args.denylist
  if (typeof args.status === 'string') payload.status = args.status
  if (typeof args.objective === 'string') payload.objective = args.objective

  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  if (status < 200 || status >= 300) {
    throw new Error(`task_update failed (${status}): ${errorMessage(body, 'http error')}`)
  }
  return { ok: true }
}
