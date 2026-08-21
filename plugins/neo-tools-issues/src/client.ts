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

export type Issue = {
  id: string
  task_id?: string | null
  title: string
  severity: string
  status: string
  host?: string | null
  evidence_paths?: string[]
  reproduction?: string | null
  verdict?: string | null
  comment?: string
}

export type CreateIssueResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

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

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error
  }
  return fallback
}

export async function createIssue(
  args: {
    title: string
    severity: string
    host?: string
    evidence_paths?: string[]
    reproduction?: string
    verdict?: string
    task_id?: string
  },
  opts: ClientOptions = {},
): Promise<CreateIssueResult> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const taskId = resolveTaskId(args.task_id ?? opts.taskId, env, opts.agent)
  const payload: Record<string, unknown> = {
    title: args.title,
    severity: args.severity,
  }
  if (taskId) payload.task_id = taskId
  if (args.host !== undefined) payload.host = args.host
  if (args.evidence_paths !== undefined) payload.evidence_paths = args.evidence_paths
  if (args.reproduction !== undefined) payload.reproduction = args.reproduction
  if (args.verdict !== undefined) payload.verdict = args.verdict

  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })

  // Domain-level rejection (e.g. thorough without verdict=confirmed) is a
  // successful tool outcome, not an infrastructure failure.
  if (status >= 400 && status < 500) {
    return { ok: false, error: errorMessage(body, `issue_create rejected (${status})`) }
  }
  if (status < 200 || status >= 300) {
    throw new Error(`issue_create failed (${status}): ${errorMessage(body, 'http error')}`)
  }

  const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'issue_create succeeded without an id' }
  }
  return { ok: true, id }
}

export async function queryIssues(
  args: { host?: string; severity?: string; status?: string; task_id?: string } = {},
  opts: ClientOptions = {},
): Promise<Issue[]> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const taskId = resolveTaskId(args.task_id ?? opts.taskId, env, opts.agent)
  const params = new URLSearchParams()
  if (args.host) params.set('host', args.host)
  if (args.severity) params.set('severity', args.severity)
  if (args.status) params.set('status', args.status)
  if (taskId) params.set('task_id', taskId)
  const qs = params.toString()
  const url = `${controlUrl(env)}/issues${qs ? `?${qs}` : ''}`
  const { status, body } = await readJson(fetchImpl, url, { method: 'GET', signal: opts.signal })
  if (status < 200 || status >= 300) {
    throw new Error(`issue_query failed (${status}): ${errorMessage(body, 'http error')}`)
  }
  if (Array.isArray(body)) return body as Issue[]
  if (body && typeof body === 'object' && Array.isArray((body as { issues?: unknown }).issues)) {
    return (body as { issues: Issue[] }).issues
  }
  return []
}

export async function updateIssue(
  args: { id: string; status?: string; comment?: string },
  opts: ClientOptions = {},
): Promise<{ ok: true }> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const payload: Record<string, unknown> = {}
  if (args.status !== undefined) payload.status = args.status
  if (args.comment !== undefined) payload.comment = args.comment

  const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/issues/${args.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  if (status >= 400 && status < 500) {
    throw new Error(errorMessage(body, `issue_update rejected (${status})`))
  }
  if (status < 200 || status >= 300) {
    throw new Error(`issue_update failed (${status}): ${errorMessage(body, 'http error')}`)
  }
  return { ok: true }
}
