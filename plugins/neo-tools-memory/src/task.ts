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

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

export function taskIdFromSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const m = sessionId.match(UUID_EXTRACT_RE)
  return m ? m[0].toLowerCase() : undefined
}

export type AgentRef = {
  id?: string
  options?: { neoTaskId?: unknown }
  parent?: { id?: string; options?: { neoTaskId?: unknown } }
  parentSession?: { id?: string }
}

export function resolveTaskId(
  arg: string | undefined,
  env: EnvMap = process.env,
  agent?: AgentRef,
): string | undefined {
  const parent = agent?.parent
  const parentOption = typeof parent?.options?.neoTaskId === 'string'
    ? parent.options.neoTaskId
    : undefined
  const option = typeof agent?.options?.neoTaskId === 'string' ? agent.options.neoTaskId : undefined
  const candidates = [
    arg,
    env.NEO_TASK_ID,
    option,
    parentOption,
    taskIdFromSession(parent?.id),
    taskIdFromSession(agent?.parentSession?.id),
    taskIdFromSession(agent?.id),
  ]
  return candidates.map((v) => v?.trim()).find((v) => v && UUID_RE.test(v))
}

function parseAllowlistEnv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function controlBase(env: EnvMap): string {
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

export async function ensureTaskId(opts: {
  arg?: string
  env?: EnvMap
  agent?: AgentRef
  fetch: FetchLike
  signal?: AbortSignal
}): Promise<string> {
  const env = opts.env ?? process.env
  const id = resolveTaskId(opts.arg, env, opts.agent)
  if (!id) throw new Error('task_id is required (set NEO_TASK_ID or pass task_id)')

  const base = controlBase(env)
  const { status } = await readJson(opts.fetch, `${base}/tasks/${id}`, {
    method: 'GET',
    signal: opts.signal,
  })
  if (status >= 200 && status < 300) return id
  if (status !== 404) {
    throw new Error(`ensure task failed (${status})`)
  }

  const mode = env.NEO_MODE === 'fast' ? 'fast' : 'thorough'
  const allowlist = parseAllowlistEnv(env.NEO_ALLOWLIST)
  const { status: createStatus, body } = await readJson(opts.fetch, `${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      mode,
      objective: 'session',
      allowlist,
    }),
    signal: opts.signal,
  })
  if (createStatus === 409 || (createStatus >= 200 && createStatus < 300)) return id
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  throw new Error(
    `ensure task create failed (${createStatus}): ${typeof err === 'string' ? err : 'http error'}`,
  )
}
