import {
  requireTaskId,
  taskHeaders,
  controlUrl,
  readJson,
  ensureRunIdentity,
} from '../../neo-runtime/contracts.mjs'
export async function controlCall(
  env: Record<string, string | undefined>,
  agent: any,
  path: string,
  body?: any,
  signal?: AbortSignal,
) {
  const response = await readJson(globalThis.fetch, controlUrl(env) + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...taskHeaders(env, agent), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `control policy rejected (${response.status}): ${response.body?.error ?? 'invalid response'}`,
    )
  return response.body
}
export async function ensureRun(
  env: Record<string, string | undefined>,
  agent: any,
  signal?: AbortSignal,
) {
  return ensureRunIdentity(env, agent, globalThis.fetch, signal)
}

export async function childRun(
  env: Record<string, string | undefined>,
  agent: any,
  role: string,
  signal?: AbortSignal,
) {
  const parent = await ensureRun(env, agent, signal)
  return controlCall(
    env,
    agent,
    `/tasks/${requireTaskId(undefined, env, agent)}/runs`,
    { role, parent_id: parent.id },
    signal,
  )
}
