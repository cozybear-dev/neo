import { readJson } from '../../neo-runtime/contracts.mjs'
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
  revision?: number
  comment?: string
}

export type CreateIssueResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

export function taskIdFromSession(
  sessionId: string | undefined,
): string | undefined {
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

export function controlUrl(env: EnvMap = process.env): string {
  return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
}

export { resolveTaskId } from '../../neo-runtime/contracts.mjs'
import {
  resolveTaskId,
  taskHeaders,
  ensureRunIdentity,
} from '../../neo-runtime/contracts.mjs'

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
  await ensureRunIdentity(env, opts.agent, fetchImpl, opts.signal)
  const payload: Record<string, unknown> = {
    title: args.title,
    severity: args.severity,
  }
  if (!taskId) throw new Error('authorized task_id required')
  payload.task_id = taskId
  if (args.host !== undefined) payload.host = args.host
  if (args.evidence_paths !== undefined)
    payload.evidence_paths = args.evidence_paths
  if (args.reproduction !== undefined) payload.reproduction = args.reproduction
  if (args.verdict === 'confirmed')
    throw new Error('confirmation requires persisted independent verification')

  const { status, body } = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/issues`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...taskHeaders(env, opts.agent),
      },
      body: JSON.stringify(payload),
      signal: opts.signal,
    },
  )

  // Domain-level rejection (e.g. thorough without verdict=confirmed) is a
  // successful tool outcome, not an infrastructure failure.
  if (status >= 400 && status < 500) {
    return {
      ok: false,
      error: errorMessage(body, `issue_create rejected (${status})`),
    }
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `issue_create failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }

  const id =
    body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'issue_create succeeded without an id' }
  }
  return { ok: true, id }
}

export async function queryIssues(
  args: {
    host?: string
    severity?: string
    status?: string
    task_id?: string
    limit?: number
    offset?: number
  } = {},
  opts: ClientOptions = {},
): Promise<Issue[]> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const taskId = resolveTaskId(args.task_id ?? opts.taskId, env, opts.agent)
  const params = new URLSearchParams()
  if (args.host) params.set('host', args.host)
  if (args.severity) params.set('severity', args.severity)
  if (args.status) params.set('status', args.status)
  if (!taskId) throw new Error('authorized task_id required')
  params.set('task_id', taskId)
  if (args.limit !== undefined) params.set('limit', String(args.limit))
  if (args.offset !== undefined) params.set('offset', String(args.offset))
  const qs = params.toString()
  const url = `${opts.controlUrl ?? controlUrl(env)}/issues${qs ? `?${qs}` : ''}`
  const { status, body } = await readJson(fetchImpl, url, {
    method: 'GET',
    headers: taskHeaders(env, opts.agent),
    signal: opts.signal,
  })
  if (status < 200 || status >= 300) {
    throw new Error(
      `issue_query failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }
  if (Array.isArray(body)) throw new Error('invalid issue list response')
  if (
    body &&
    typeof body === 'object' &&
    Array.isArray((body as { issues?: unknown }).issues)
  ) {
    const issues = (body as { issues: Issue[] }).issues
    if (
      !issues.every(
        (issue) =>
          issue &&
          typeof issue.id === 'string' &&
          typeof issue.title === 'string' &&
          typeof issue.severity === 'string' &&
          typeof issue.status === 'string',
      )
    )
      throw new Error('invalid issue list response')
    return issues
  }
  throw new Error('invalid issue list response')
}

export async function updateIssue(
  args: {
    id: string
    revision: number
    status?: string
    comment?: string
    verification_id?: string
    evidence_paths?: string[]
    reproduction?: string
  },
  opts: ClientOptions = {},
): Promise<{ ok: true }> {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const payload: Record<string, unknown> = { revision: args.revision }
  if (args.verification_id) payload.verification_id = args.verification_id
  if (args.evidence_paths) payload.evidence_paths = args.evidence_paths
  if (args.reproduction) payload.reproduction = args.reproduction
  if (args.status !== undefined) payload.status = args.status
  if (args.comment !== undefined) payload.comment = args.comment

  const { status, body } = await readJson(
    fetchImpl,
    `${opts.controlUrl ?? controlUrl(env)}/issues/${args.id}`,
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
  if (status >= 400 && status < 500) {
    throw new Error(errorMessage(body, `issue_update rejected (${status})`))
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `issue_update failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as any).id !== 'string' ||
    typeof (body as any).revision !== 'number'
  )
    throw new Error('invalid issue update response')
  return { ok: true }
}
