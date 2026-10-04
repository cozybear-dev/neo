/** Run on the operator host, never inside agent containers. JSON request payload is read from stdin. */
const [command, id] = process.argv.slice(2)
const paths: Record<string, string> = {
  create: '/tasks',
  approve: `/tasks/${id}/approvals`,
  authorize: `/tasks/${id}/authorizations`,
  inspect: `/tasks/${id}`,
  mode: `/tasks/${id}`,
  retire: `/tasks/${id}`,
}
if (!paths[command] || !process.env.NEO_CONTROL_ADMIN_TOKEN)
  throw new Error(
    'usage: operator create|approve|authorize|inspect|mode|retire [task-id]; set operator-only NEO_CONTROL_ADMIN_TOKEN',
  )
let body = ''
if (!['inspect', 'retire'].includes(command))
  for await (const chunk of process.stdin) body += chunk
const response = await fetch(
  `${process.env.CONTROL_URL ?? 'http://127.0.0.1:8090'}${paths[command]}`,
  {
    method:
      command === 'inspect'
        ? 'GET'
        : command === 'retire'
          ? 'DELETE'
          : command === 'mode'
            ? 'PATCH'
            : 'POST',
    headers: {
      authorization: `Bearer ${process.env.NEO_CONTROL_ADMIN_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body || undefined,
    signal: AbortSignal.timeout(15000),
  },
)
const text = await response.text()
process.stdout.write(text + '\n')
if (!response.ok) process.exitCode = 1
export {}
