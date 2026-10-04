import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { sessionGrant, sessionMode } from '../../control/src/session.ts'
import {
  chatAlreadyBound,
  objectiveFromMessage,
  openChatSession,
} from '../../plugins/neo-orchestrator/src/session-open.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const id = '11111111-1111-4111-8111-111111111111'
const token = 'session-task-token-value'

function textMessage(kind: string, text: string) {
  return {
    role: 'user',
    source: { kind },
    content: [{ type: 'text', text }],
  }
}

test('session mode defaults to thorough and rejects unknown values', () => {
  assert.equal(sessionMode(undefined), 'thorough')
  assert.equal(sessionMode(' fast '), 'fast')
  assert.throws(() => sessionMode('slow'), /NEO_MODE_DEFAULT/)
})

test('session grant copies the env allowlist and refuses an empty one', () => {
  assert.deepEqual(sessionGrant(['huntandhackett.com', '*.huntandhackett.com'], 'thorough'), {
    mode: 'thorough',
    allowlist: ['huntandhackett.com', '*.huntandhackett.com'],
    denylist: [],
  })
  assert.throws(() => sessionGrant([], 'fast'), /NEO_ALLOWLIST is empty/)
})

test('only a typed user message is a task objective', () => {
  assert.equal(
    objectiveFromMessage(textMessage('user', ' pentest huntandhackett.com ')),
    'pentest huntandhackett.com',
  )
  assert.equal(
    objectiveFromMessage(textMessage('runtime-context', 'Current runtime context')),
    undefined,
  )
  assert.equal(
    objectiveFromMessage(textMessage('skill-catalog', 'available skills')),
    undefined,
  )
  assert.equal(objectiveFromMessage(textMessage('user', '   ')), undefined)
})

test('the first typed message opens one task and a later message does not', async () => {
  const agent: { options?: Record<string, unknown> } = {}
  let calls = 0
  const fetchImpl = async (_url: string, init?: { body?: string }) => {
    calls += 1
    assert.equal(JSON.parse(init?.body ?? '{}').objective, 'pentest huntandhackett.com')
    assert.equal(JSON.parse(init?.body ?? '{}').allowlist, undefined)
    return {
      status: 201,
      text: async () =>
        JSON.stringify({ id, task_token: token, mode: 'thorough' }),
    }
  }
  const env = {
    NEO_SESSION_OPEN_TOKEN: 'opener',
    CONTROL_URL: 'http://control:8090',
  }
  const first = openChatSession(agent, 'pentest huntandhackett.com', {
    env,
    fetch: fetchImpl,
  })
  const concurrent = openChatSession(agent, 'pentest huntandhackett.com', {
    env,
    fetch: fetchImpl,
  })
  await Promise.all([first, concurrent])
  await openChatSession(agent, 'look again', { env, fetch: fetchImpl })
  assert.equal(calls, 1)
  assert.equal(agent.options?.neoTaskId, id)
  assert.equal(agent.options?.neoTaskToken, token)
  assert.equal(agent.options?.neoMode, 'thorough')
  assert.equal(chatAlreadyBound(env, agent), true)
})

test('an explicit task binding is left unchanged', async () => {
  let calls = 0
  const agent = {}
  await openChatSession(agent, 'pentest huntandhackett.com', {
    env: { NEO_TASK_ID: id, NEO_TASK_TOKEN: token },
    fetch: async () => {
      calls += 1
      return { status: 500, text: async () => '' }
    },
  })
  assert.equal(calls, 0)
  assert.equal(chatAlreadyBound({ NEO_TASK_ID: id, NEO_TASK_TOKEN: token }, agent), true)
})

test('compose starts the UI without a starter task', () => {
  const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
  const services = compose.services
  assert.equal(services.starter, undefined)
  assert.equal(services.dsh.depends_on.starter, undefined)
  assert.equal(services.dsh.depends_on.control.condition, 'service_healthy')
  assert.equal(services.dsh.environment.NEO_CONTROL_ADMIN_TOKEN, undefined)
  assert.equal(services.dsh.environment.NEO_TASK_FILE, undefined)
  assert.equal(
    services.dsh.environment.NEO_MODE_DEFAULT,
    '${NEO_MODE_DEFAULT:-thorough}',
  )
  assert.equal(
    services.control.environment.NEO_MODE_DEFAULT,
    '${NEO_MODE_DEFAULT:-thorough}',
  )
  assert.equal(services.control.user, '0:0')
  assert.ok(services.control.volumes.includes('task-state:/state'))
  assert.ok(services.dsh.volumes.includes('task-state:/run/neo-task:ro'))
  for (const name of ['broker', 'sandbox', 'browser', 'postgres', 'interactsh']) {
    const volumes = services[name].volumes ?? []
    assert.equal(
      volumes.some((volume: string) => String(volume).startsWith('task-state:')),
      false,
      name,
    )
  }
  const entrypoint = readFileSync(join(root, 'docker/dsh/entrypoint.sh'), 'utf8')
  assert.doesNotMatch(entrypoint, /load-task-env/)
  assert.doesNotMatch(entrypoint, /no task credential/)
  assert.match(entrypoint, /session-open\.token/)
  const controlEntry = readFileSync(
    join(root, 'docker/control/entrypoint.sh'),
    'utf8',
  )
  assert.match(controlEntry, /session-open\.token/)
  assert.match(controlEntry, /preserve-environment/)
  assert.match(
    readFileSync(join(root, 'docker/control/Dockerfile'), 'utf8'),
    /ENTRYPOINT \["\/entrypoint\.sh"\]/,
  )
})
