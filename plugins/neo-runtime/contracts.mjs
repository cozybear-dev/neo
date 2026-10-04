export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function present(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
export function resolveTaskId(arg, env = process.env, agent) {
  const binding =
    present(env.NEO_TASK_ID) ??
    present(agent?.options?.neoTaskId) ??
    present(agent?.parent?.options?.neoTaskId)
  if (arg !== undefined && !UUID_RE.test(arg))
    throw new Error('invalid explicit task_id')
  if (binding !== undefined && !UUID_RE.test(binding))
    throw new Error('invalid bound task_id')
  if (arg && binding && arg.toLowerCase() !== binding.toLowerCase())
    throw new Error('task_id differs from runtime binding')
  return (binding ?? arg)?.toLowerCase()
}
export function requireTaskId(arg, env = process.env, agent) {
  const id = resolveTaskId(arg, env, agent)
  if (!id) throw new Error('authorized task identity required')
  return id
}
export function taskToken(env = process.env, agent) {
  const envId = present(env.NEO_TASK_ID)
  const envToken = present(env.NEO_TASK_TOKEN)
  const token =
    (envId && envToken ? envToken : undefined) ??
    present(agent?.options?.neoTaskToken) ??
    present(agent?.parent?.options?.neoTaskToken) ??
    envToken
  if (!token) throw new Error('NEO_TASK_TOKEN is required')
  return token
}
export function taskHeaders(env = process.env, agent) {
  return {
    authorization: `Bearer ${taskToken(env, agent)}`,
    ...((agent?.options?.neoRunToken ?? env.NEO_RUN_TOKEN)
      ? { 'x-neo-run-token': agent?.options?.neoRunToken ?? env.NEO_RUN_TOKEN }
      : {}),
  }
}
export function controlUrl(env = process.env, override) {
  const value = override ?? env.CONTROL_URL ?? 'http://control:8090'
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('invalid control URL')
  return value.replace(/\/+$/, '')
}
export async function readJson(fetchImpl, url, init = {}) {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000)
  const response = await fetchImpl(url, { ...init, signal })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`invalid JSON response (${response.status})`)
  }
  return { status: response.status, body }
}
const rootRuns = new WeakMap()
export async function ensureRunIdentity(
  env = process.env,
  agent,
  fetchImpl = globalThis.fetch,
  signal,
) {
  if (!agent || typeof agent !== 'object')
    throw new Error('agent runtime identity required')
  if (agent.options?.neoRunId && agent.options?.neoRunToken)
    return { id: agent.options.neoRunId, run_token: agent.options.neoRunToken }
  let pending = rootRuns.get(agent)
  if (!pending) {
    pending = readJson(
      fetchImpl,
      `${controlUrl(env)}/tasks/${requireTaskId(undefined, env, agent)}/runs`,
      {
        method: 'POST',
        headers: { ...taskHeaders(env, agent), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'orchestrator' }),
        signal,
      },
    ).then(({ status, body }) => {
      if (
        status !== 200 ||
        typeof body?.id !== 'string' ||
        typeof body?.run_token !== 'string'
      )
        throw new Error(`run registration failed (${status})`)
      agent.options ??= {}
      agent.options.neoRunId = body.id
      agent.options.neoRunToken = body.run_token
      return body
    })
    rootRuns.set(agent, pending)
    // Keep concurrent callers on one registration, but allow recovery after a
    // transient control failure or cancellation.
    pending.catch(() => {
      if (rootRuns.get(agent) === pending) rootRuns.delete(agent)
    })
  }
  return pending
}
