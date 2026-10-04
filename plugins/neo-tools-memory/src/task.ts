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

export const UUID_RE =
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

export { resolveTaskId } from '../../neo-runtime/contracts.mjs'
import {
  resolveTaskId,
  taskHeaders,
  controlUrl,
} from '../../neo-runtime/contracts.mjs'

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

export async function ensureTaskId(opts: {
  arg?: string
  env?: EnvMap
  agent?: AgentRef
  fetch: FetchLike
  signal?: AbortSignal
}): Promise<string> {
  const env = opts.env ?? process.env
  const id = resolveTaskId(opts.arg, env, opts.agent)
  if (!id)
    throw new Error('task_id is required (set NEO_TASK_ID or pass task_id)')

  const { status, body } = await readJson(
    opts.fetch,
    `${controlUrl(env)}/tasks/${id}`,
    {
      method: 'GET',
      headers: taskHeaders(env, opts.agent),
      signal: opts.signal,
    },
  )
  if (
    status >= 200 &&
    status < 300 &&
    body &&
    typeof body === 'object' &&
    (body as { id?: string }).id === id
  )
    return id
  throw new Error(
    `authorized task lookup failed (${status}); operator must create task before workflow entry`,
  )
}
