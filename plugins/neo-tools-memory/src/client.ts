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

export function resolveTaskId(arg: string | undefined, env: EnvMap = process.env): string {
  const value = arg ?? env.NEO_TASK_ID
  if (!value || !value.trim()) {
    throw new Error('task_id is required (set NEO_TASK_ID or pass task_id)')
  }
  return value.trim()
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

export async function getMemory(
  args: { task_id?: string } = {},
  opts: ClientOptions = {},
): Promise<MemorySnapshot> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const id = resolveTaskId(args.task_id ?? opts.taskId, env)
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
  const id = resolveTaskId(args.task_id ?? opts.taskId, env)
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
