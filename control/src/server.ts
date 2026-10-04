import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isIP } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { createPool, migrate, type Db } from './db.js'
import { normalizeScopeHost } from './host.js'
import { sessionGrant, sessionMode } from './session.js'
export type AppOptions = {
  databaseUrl?: string
  allowlistEnv?: string
  modeDefault?: string
  sessionOpenToken?: string
  pool?: Db
  adminToken?: string
  brokerToken?: string
  logger?: boolean
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
const token = () => randomBytes(32).toString('base64url')
function fail(code: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: code })
}
function validId(value: any) {
  if (typeof value !== 'string' || !uuid.test(value))
    fail(400, 'invalid task or resource id')
  return value
}
function patterns(value: any): string[] {
  if (!Array.isArray(value) || value.length > 256)
    fail(400, 'scope must be an array of at most 256 entries')
  for (const p of value) {
    if (
      typeof p !== 'string' ||
      p.length > 253 ||
      !(
        /^(\*\.)?[a-z0-9][a-z0-9.-]*$/i.test(p) ||
        /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(p)
      )
    )
      fail(
        400,
        'scope supports hostname, wildcard hostname, IPv4 or IPv4 CIDR only',
      )
    if (!p.includes('/')) {
      const host = p.startsWith('*.') ? p.slice(2) : p
      if (
        host
          .split('.')
          .some(
            (label) =>
              !label ||
              label.length > 63 ||
              label.startsWith('-') ||
              label.endsWith('-'),
          )
      )
        fail(400, 'invalid hostname scope')
      if (/^[0-9.]+$/.test(host) && isIP(host) !== 4)
        fail(400, 'invalid IPv4 scope')
    }
    if (p.includes('/')) {
      const [ip, bits] = p.split('/')
      if (isIP(ip) !== 4 || +bits < 0 || +bits > 32)
        fail(400, 'invalid IPv4 CIDR')
    }
  }
  return value.map((p) => p.toLowerCase())
}
export function matchPattern(
  patterns: string[],
  target: string,
): string | null {
  for (const p of patterns) {
    if (p.includes('/') && isIP(target) === 4) {
      const [ip, b] = p.split('/')
      const num = (v: string) =>
        v.split('.').reduce((n, x) => (n * 256 + Number(x)) >>> 0, 0)
      const mask = +b === 0 ? 0 : (0xffffffff << (32 - +b)) >>> 0
      if ((num(ip) & mask) === (num(target) & mask)) return p
    } else if (
      target.toLowerCase() === p.toLowerCase() ||
      (p.startsWith('*.') &&
        (target === p.slice(2) || target.endsWith('.' + p.slice(2))))
    )
      return p
  }
  return null
}
export function checkScope(input: {
  target: string
  envAllowlist: string[]
  taskAllowlist?: string[]
  taskDenylist?: string[]
}) {
  const target = normalizeScopeHost(input.target)
  const denied = matchPattern(input.taskDenylist ?? [], target)
  if (denied)
    return { allowed: false, matched: denied, reason: 'matched denylist' }
  const granted = matchPattern(input.taskAllowlist ?? [], target)
  const ceiling =
    input.envAllowlist.length === 0 || matchPattern(input.envAllowlist, target)
  if (granted && ceiling)
    return {
      allowed: true,
      matched: granted,
      reason: 'matched approved task scope',
    }
  if (!granted)
    return { allowed: false, matched: '', reason: 'not in the task allowlist' }
  return {
    allowed: false,
    matched: granted,
    reason: 'outside NEO_ALLOWLIST',
  }
}
const str = {
  type: 'string',
  minLength: 1,
  maxLength: 16384,
  pattern: '\\S',
} as const
const idSchema = { type: 'string', pattern: uuid.source } as const
const list = {
  type: 'array',
  maxItems: 256,
  items: { type: 'string', maxLength: 4096 },
} as const
const revision = { type: 'integer', minimum: 0 } as const
const schema = (properties: Record<string, any>, required: string[] = []) => ({
  body: { type: 'object', additionalProperties: false, properties, required },
})
export async function buildApp(
  opts: AppOptions = {},
): Promise<FastifyInstance> {
  const admin = opts.adminToken ?? process.env.NEO_CONTROL_ADMIN_TOKEN
  const broker = opts.brokerToken ?? process.env.NEO_CONTROL_BROKER_TOKEN
  if (!admin || admin.length < 24 || !broker || broker.length < 24)
    throw new Error(
      'separate NEO_CONTROL_ADMIN_TOKEN and NEO_CONTROL_BROKER_TOKEN (24+ characters) required',
    )
  if (equal(admin, broker))
    throw new Error('admin and broker tokens must differ')
  const modeDefault = sessionMode(
    opts.modeDefault ?? process.env.NEO_MODE_DEFAULT,
  )
  const opener = opts.sessionOpenToken ?? process.env.NEO_SESSION_OPEN_TOKEN
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
  if (!opts.pool && !databaseUrl) throw new Error('DATABASE_URL required')
  const pool = opts.pool ?? createPool(databaseUrl!)
  try {
    await migrate(pool)
  } catch (error) {
    if ((error as { code?: string }).code === '28P01')
      throw new Error(
        'database password rejected for user neo; the pgdata volume still has a different role password',
        { cause: error },
      )
    throw error
  }
  const ceiling = patterns(
    (opts.allowlistEnv ?? process.env.NEO_ALLOWLIST ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  )
  const app: FastifyInstance = Fastify({
    logger: opts.logger ?? {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.body.task_token',
        'res.body.task_token',
        'res.body.run_token',
      ],
    },
    bodyLimit: 1048576,
  } as any) as unknown as FastifyInstance
  app.addHook('onClose', async () => {
    if (!opts.pool) await pool.end()
  })
  app.setErrorHandler((caught, req, reply) => {
    const error = caught as any
    const status = error.statusCode ?? 500
    if (status >= 500)
      req.log.error(
        {
          err: { name: error.name, code: (error as any).code },
          request_id: req.id,
        },
        'control request failed',
      )
    reply.code(status).send({
      error: status >= 500 ? 'control service unavailable' : error.message,
    })
  })
  const bearer = (req: any) => {
    const value = req.headers.authorization
    if (typeof value !== 'string' || !value.startsWith('Bearer '))
      fail(401, 'bearer credential required')
    return value.slice(7)
  }
  const adminOnly = (req: any) => {
    if (!equal(bearer(req), admin)) fail(403, 'operator authorization required')
  }
  async function task(req: any, id: string, capability = 'read') {
    validId(id)
    const result = await pool.query('SELECT * FROM tasks WHERE id=$1', [id])
    if (!result.rowCount) fail(404, 'task not found')
    const row = result.rows[0]
    const auth = bearer(req)
    if (!equal(auth, admin!) && hash(auth) !== row.token_hash)
      fail(403, 'credential does not own task')
    if (
      capability !== 'read' &&
      ['completed', 'cancelled'].includes(row.status)
    )
      fail(409, 'task is terminal')
    return row
  }
  async function approved(row: any) {
    return !!(
      await pool.query(
        'SELECT id FROM task_approvals WHERE task_id=$1 AND plan_revision=$2',
        [row.id, row.plan_revision],
      )
    ).rowCount
  }
  async function tx<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const value = await fn(c)
      await c.query('COMMIT')
      return value
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  }
  function publicTask(row: any) {
    const { token_hash, ...rest } = row
    return rest
  }
  const taskResponse = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'mode',
      'objective',
      'allowlist',
      'denylist',
      'status',
      'revision',
      'plan_revision',
    ],
    properties: {
      id: idSchema,
      mode: { enum: ['fast', 'thorough'] },
      objective: str,
      allowlist: list,
      denylist: list,
      status: { enum: ['pending', 'running', 'completed', 'cancelled'] },
      revision,
      plan_revision: revision,
      plan: { type: 'string' },
      created_at: { type: 'string' },
      task_token: { type: 'string' },
      runs: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      approved: { type: 'boolean' },
      allowed: { type: 'boolean' },
      global_ceiling: list,
    },
  }
  const memoryResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['task_id', 'revision', 'insights', 'facts', 'todos', 'files'],
    properties: {
      task_id: idSchema,
      revision,
      insights: { type: 'array' },
      facts: { type: 'array' },
      todos: { type: 'array' },
      files: { type: 'array' },
      updated_at: { type: 'string' },
    },
  }
  app.addHook('onRoute', (route) => {
    const url = route.url
    const method = route.method
    const response =
      method === 'DELETE'
        ? undefined
        : url === '/tasks' ||
            url === '/session' ||
            url === '/tasks/:id' ||
            url === '/tasks/:id/plan' ||
            url === '/tasks/:id/authorizations' ||
            url === '/internal/authorize'
          ? taskResponse
          : url === '/tasks/:id/memory'
            ? memoryResponse
            : url === '/scope/check'
              ? {
                  type: 'object',
                  additionalProperties: false,
                  required: ['allowed', 'matched', 'reason'],
                  properties: {
                    allowed: { type: 'boolean' },
                    matched: { type: 'string' },
                    reason: { type: 'string' },
                  },
                }
              : undefined
    if (response) {
      route.schema ??= {}
      route.schema.response = {
        ...(route.schema.response ?? {}),
        '2xx': response,
      }
    }
  })
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async (req, reply) => {
    try {
      await pool.query('SELECT 1')
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })
  app.post(
    '/session',
    {
      schema: schema({ objective: str }, ['objective']),
      preValidation: async (req: any) => {
        const body = req.body
        if (!body || typeof body !== 'object' || Array.isArray(body)) return
        if (Object.keys(body).some((key) => key !== 'objective'))
          fail(400, 'session accepts only an objective')
      },
    },
    async (req: any, reply) => {
      if (!opener) fail(503, 'session open is not configured')
      if (!equal(bearer(req), opener)) fail(403, 'session opener required')
      const grant = sessionGrant(ceiling, modeDefault)
      const id = randomUUID()
      const secret = token()
      try {
        const row = await tx(async (c) => {
          const result = await c.query(
            'INSERT INTO tasks(id,mode,objective,allowlist,denylist,status,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              id,
              grant.mode,
              req.body.objective,
              grant.allowlist,
              grant.denylist,
              'pending',
              hash(secret),
            ],
          )
          await c.query('INSERT INTO task_memory(task_id) VALUES($1)', [id])
          await c.query(
            'INSERT INTO task_authorizations(id,task_id,revision,actor,reason,policy) VALUES($1,$2,0,$3,$4,$5)',
            [
              randomUUID(),
              id,
              'chat',
              'opened from the chat',
              JSON.stringify({
                allowlist: grant.allowlist,
                denylist: grant.denylist,
              }),
            ],
          )
          return result.rows[0]
        })
        return reply.code(201).send({ ...publicTask(row), task_token: secret })
      } catch (e) {
        if ((e as any).code === '23505') fail(409, 'task already exists')
        throw e
      }
    },
  )
  app.post(
    '/tasks',
    {
      schema: schema(
        {
          id: idSchema,
          mode: { enum: ['fast', 'thorough'] },
          objective: str,
          allowlist: list,
          denylist: list,
        },
        ['mode', 'objective', 'allowlist'],
      ),
    },
    async (req: any, reply) => {
      adminOnly(req)
      const b = req.body
      const id = b.id ?? randomUUID()
      const secret = token()
      const allow = patterns(b.allowlist),
        deny = patterns(b.denylist ?? [])
      try {
        const row = await tx(async (c) => {
          const result = await c.query(
            'INSERT INTO tasks(id,mode,objective,allowlist,denylist,status,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [id, b.mode, b.objective, allow, deny, 'pending', hash(secret)],
          )
          await c.query('INSERT INTO task_memory(task_id) VALUES($1)', [id])
          await c.query(
            'INSERT INTO task_authorizations(id,task_id,revision,actor,reason,policy) VALUES($1,$2,0,$3,$4,$5)',
            [
              randomUUID(),
              id,
              'operator',
              'initial task authorization',
              JSON.stringify({ allowlist: allow, denylist: deny }),
            ],
          )
          return result.rows[0]
        })
        return reply.code(201).send({ ...publicTask(row), task_token: secret })
      } catch (e) {
        if ((e as any).code === '23505') fail(409, 'task already exists')
        throw e
      }
    },
  )
  app.get('/tasks/:id', async (req: any) => {
    const row = await task(req, req.params.id)
    const runs = await pool.query(
      'SELECT id,parent_id,role,status,outcome,created_at,finished_at FROM task_runs WHERE task_id=$1 ORDER BY created_at LIMIT 128',
      [row.id],
    )
    return { ...publicTask(row), runs: runs.rows }
  })
  app.patch(
    '/tasks/:id',
    {
      schema: schema(
        {
          mode: { enum: ['fast', 'thorough'] },
          objective: str,
          status: { enum: ['pending', 'running', 'completed', 'cancelled'] },
          revision,
        },
        ['revision'],
      ),
    },
    async (req: any) => {
      const row = await task(req, req.params.id, 'write')
      const b = req.body
      if (b.mode) adminOnly(req)
      if (b.mode && row.status !== 'pending')
        fail(409, 'mode can only change before execution')
      const keys = Object.keys(b).filter((k) => k !== 'revision')
      if (!keys.length) fail(400, 'no changes')
      const values = keys.map((k) => b[k])
      const result = await pool.query(
        `UPDATE tasks SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')},revision=revision+1${keys.some((k) => k === 'objective' || k === 'mode') ? ',plan_revision=plan_revision+1' : ''} WHERE id=$1 AND revision=$2 RETURNING *`,
        [row.id, b.revision, ...values],
      )
      if (!result.rowCount) fail(409, 'stale task revision')
      return publicTask(result.rows[0])
    },
  )
  app.post(
    '/tasks/:id/authorizations',
    {
      schema: schema(
        { allowlist: list, denylist: list, reason: str, revision },
        ['allowlist', 'denylist', 'reason', 'revision'],
      ),
    },
    async (req: any) => {
      adminOnly(req)
      const row = await task(req, req.params.id, 'write')
      const b = req.body
      const allow = patterns(b.allowlist),
        deny = patterns(b.denylist)
      return tx(async (c) => {
        const r = await c.query(
          'UPDATE tasks SET allowlist=$3,denylist=$4,revision=revision+1,plan_revision=plan_revision+1 WHERE id=$1 AND revision=$2 RETURNING *',
          [row.id, b.revision, allow, deny],
        )
        if (!r.rowCount) fail(409, 'stale task revision')
        await c.query(
          'INSERT INTO task_authorizations(id,task_id,revision,actor,reason,policy) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            row.id,
            r.rows[0].revision,
            'operator',
            b.reason,
            JSON.stringify({ allowlist: allow, denylist: deny }),
          ],
        )
        return publicTask(r.rows[0])
      })
    },
  )
  app.get('/tasks/:id/memory', async (req: any) => {
    const row = await task(req, req.params.id)
    return (
      await pool.query('SELECT * FROM task_memory WHERE task_id=$1', [row.id])
    ).rows[0]
  })
  const mem = { type: 'array', maxItems: 1000, items: {} }
  app.put(
    '/tasks/:id/memory',
    {
      schema: schema(
        { insights: mem, facts: mem, todos: mem, files: mem, revision },
        ['revision'],
      ),
    },
    async (req: any) => {
      const row = await task(req, req.params.id, 'write')
      const b = req.body
      const keys = Object.keys(b).filter((k) => k !== 'revision')
      if (!keys.length) fail(400, 'no memory changes')
      const r = await pool.query(
        `UPDATE task_memory SET ${keys.map((k, i) => `${k}=$${i + 3}::jsonb`).join(',')},updated_at=now(),revision=revision+1 WHERE task_id=$1 AND revision=$2 RETURNING *`,
        [row.id, b.revision, ...keys.map((k) => JSON.stringify(b[k]))],
      )
      if (!r.rowCount) fail(409, 'stale memory revision')
      return r.rows[0]
    },
  )
  app.post(
    '/scope/check',
    {
      schema: schema({ task_id: idSchema, target: str }, ['task_id', 'target']),
    },
    async (req: any) => {
      const row = await task(req, req.body.task_id)
      return checkScope({
        target: req.body.target,
        envAllowlist: ceiling,
        taskAllowlist: row.allowlist,
        taskDenylist: row.denylist,
      })
    },
  )
  app.post(
    '/tasks/:id/plan',
    { schema: schema({ plan: str, revision }, ['plan', 'revision']) },
    async (req: any) => {
      const row = await task(req, req.params.id, 'write')
      const r = await pool.query(
        'UPDATE tasks SET plan=$3,plan_revision=plan_revision+1,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *',
        [row.id, req.body.revision, req.body.plan],
      )
      if (!r.rowCount) fail(409, 'stale task revision')
      return publicTask(r.rows[0])
    },
  )
  app.post(
    '/tasks/:id/approvals',
    {
      schema: schema({ revision, plan_revision: revision }, [
        'revision',
        'plan_revision',
      ]),
    },
    async (req: any) => {
      adminOnly(req)
      return tx(async (c) => {
        const r = await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [
          validId(req.params.id),
        ])
        if (!r.rowCount) fail(404, 'task not found')
        const row = r.rows[0]
        if (
          row.revision !== req.body.revision ||
          row.plan_revision !== req.body.plan_revision ||
          !row.plan
        )
          fail(409, 'approval requires current nonempty plan')
        const id = randomUUID()
        await c.query(
          'INSERT INTO task_approvals(id,task_id,task_revision,plan_revision,actor) VALUES($1,$2,$3,$4,$5)',
          [id, row.id, row.revision, row.plan_revision, 'operator'],
        )
        return { id, approved: true }
      })
    },
  )
  app.post(
    '/internal/authorize',
    {
      schema: schema(
        {
          task_id: idSchema,
          task_token: str,
          capability: {
            enum: [
              'exec',
              'deploy',
              'browser',
              'traffic',
              'delegate',
              'cleanup',
            ],
          },
          target: str,
        },
        ['task_id', 'task_token', 'capability'],
      ),
    },
    async (req: any) => {
      if (!equal(bearer(req), broker)) fail(403, 'broker credential required')
      const row = await task(
        { headers: { authorization: 'Bearer ' + req.body.task_token } },
        req.body.task_id,
        req.body.capability === 'cleanup' ? 'read' : 'write',
      )
      const approval = await approved(row)
      if (
        req.body.capability !== 'cleanup' &&
        row.mode === 'thorough' &&
        !approval
      )
        fail(403, 'current plan approval required')
      const result = req.body.target
        ? checkScope({
            target: req.body.target,
            envAllowlist: ceiling,
            taskAllowlist: row.allowlist,
            taskDenylist: row.denylist,
          })
        : { allowed: true }
      if (!result.allowed) fail(403, 'destination outside approved scope')
      return {
        ...publicTask(row),
        approved: approval,
        allowed: true,
        global_ceiling: ceiling,
      }
    },
  )
  async function run(req: any, taskId: string) {
    const secret = req.headers['x-neo-run-token']
    if (typeof secret !== 'string') fail(403, 'run credential required')
    const r = await pool.query(
      'SELECT * FROM task_runs WHERE task_id=$1 AND token_hash=$2',
      [taskId, hash(secret)],
    )
    if (!r.rowCount) fail(403, 'invalid run credential')
    if (r.rows[0].status !== 'running') fail(409, 'run is terminal')
    return r.rows[0]
  }
  app.post(
    '/tasks/:id/runs',
    {
      schema: schema(
        {
          role: {
            enum: [
              'orchestrator',
              'planner',
              'judge',
              'specialist',
              'swarm',
              'explore',
              'verifier',
            ],
          },
          parent_id: idSchema,
        },
        ['role'],
      ),
    },
    async (req: any) => {
      const row = await task(req, req.params.id, 'write'),
        b = req.body
      const count = await pool.query(
        'SELECT count(*)::int AS count FROM task_runs WHERE task_id=$1',
        [row.id],
      )
      if (count.rows[0].count >= 128) fail(409, 'task run budget exceeded')
      let parent: any
      if (b.parent_id) {
        parent = await run(req, row.id)
        if (parent.id !== b.parent_id) fail(403, 'parent identity mismatch')
      } else if (b.role !== 'orchestrator')
        fail(403, 'root must be orchestrator')
      const permitted: Record<string, string[]> = {
        orchestrator: ['planner', 'judge', 'specialist', 'swarm', 'explore'],
        planner: ['explore'],
        judge: ['verifier'],
        specialist: ['explore'],
        swarm: ['specialist', 'explore'],
        explore: [],
        verifier: [],
      }
      if (parent && !permitted[parent.role]?.includes(b.role))
        fail(403, 'forbidden delegation')
      if (
        parent &&
        row.mode === 'thorough' &&
        ['judge', 'specialist', 'verifier', 'swarm'].includes(b.role) &&
        !(await approved(row))
      )
        fail(403, 'plan approval required')
      const id = randomUUID(),
        secret = token()
      await tx(async (c) => {
        const locked = (
          await c.query('SELECT status FROM tasks WHERE id=$1 FOR UPDATE', [
            row.id,
          ])
        ).rows[0]
        if (['completed', 'cancelled'].includes(locked.status))
          fail(409, 'task terminal')
        if (parent) {
          const currentParent = (
            await c.query(
              'SELECT status FROM task_runs WHERE id=$1 AND task_id=$2 FOR UPDATE',
              [parent.id, row.id],
            )
          ).rows[0]
          if (!currentParent || currentParent.status !== 'running')
            fail(409, 'parent run is terminal')
        }
        const current = (
          await c.query('SELECT * FROM tasks WHERE id=$1', [row.id])
        ).rows[0]
        if (
          parent &&
          current.mode === 'thorough' &&
          ['judge', 'specialist', 'verifier', 'swarm'].includes(b.role)
        ) {
          const approval = await c.query(
            'SELECT id FROM task_approvals WHERE task_id=$1 AND plan_revision=$2',
            [row.id, current.plan_revision],
          )
          if (!approval.rowCount) fail(403, 'current plan approval required')
        }
        const count = await c.query(
          'SELECT count(*)::int AS count FROM task_runs WHERE task_id=$1',
          [row.id],
        )
        if (count.rows[0].count >= 128) fail(409, 'task run budget exceeded')
        const perRole = await c.query(
          'SELECT count(*)::int AS count FROM task_runs WHERE task_id=$1 AND role=$2 AND parent_id IS NOT DISTINCT FROM $3',
          [row.id, b.role, b.parent_id ?? null],
        )
        const max =
          b.role === 'swarm'
            ? 3
            : b.role === 'verifier'
              ? 5
              : parent?.role === 'planner' && b.role === 'explore'
                ? 3
                : 128
        if (perRole.rows[0].count >= max)
          fail(409, 'delegation attempts limit exceeded')
        await c.query(
          'INSERT INTO task_runs(id,task_id,parent_id,role,token_hash) VALUES($1,$2,$3,$4,$5)',
          [id, row.id, b.parent_id ?? null, b.role, hash(secret)],
        )
      })
      return { id, role: b.role, run_token: secret }
    },
  )
  app.post(
    '/tasks/:id/runs/:run/finish',
    {
      schema: schema(
        {
          status: { enum: ['completed', 'failed', 'unavailable', 'cancelled'] },
          outcome: { type: 'object', additionalProperties: true },
        },
        ['status', 'outcome'],
      ),
    },
    async (req: any) => {
      const row = await task(req, req.params.id)
      const identity = await run(req, row.id)
      if (identity.id !== validId(req.params.run))
        fail(403, 'run ownership mismatch')
      const r = await pool.query(
        'UPDATE task_runs SET status=$3,outcome=$4,finished_at=now() WHERE id=$1 AND task_id=$2 AND status=$5 RETURNING id,status,finished_at',
        [
          identity.id,
          row.id,
          req.body.status,
          JSON.stringify(req.body.outcome),
          'running',
        ],
      )
      if (!r.rowCount) fail(409, 'run already finished')
      return r.rows[0]
    },
  )
  app.delete('/tasks/:id', async (req: any) => {
    adminOnly(req)
    const row = await task(req, req.params.id)
    if (!['completed', 'cancelled'].includes(row.status))
      fail(409, 'retention deletion requires terminal task')
    await tx(async (c) => {
      await c.query(
        'DELETE FROM issue_history WHERE issue_id IN (SELECT id FROM issues WHERE task_id=$1)',
        [row.id],
      )
      await c.query(
        'DELETE FROM issue_verifications WHERE issue_id IN (SELECT id FROM issues WHERE task_id=$1)',
        [row.id],
      )
      for (const table of [
        'issues',
        'task_runs',
        'task_approvals',
        'task_authorizations',
        'task_memory',
      ])
        await c.query(`DELETE FROM ${table} WHERE task_id=$1`, [row.id])
      await c.query('DELETE FROM tasks WHERE id=$1', [row.id])
    })
    return { deleted: true, id: row.id }
  })
  const props = {
    task_id: idSchema,
    title: str,
    severity: { enum: ['info', 'low', 'medium', 'high', 'critical'] },
    status: { enum: ['unverified', 'confirmed', 'open', 'false_positive'] },
    host: str,
    evidence_paths: list,
    reproduction: str,
    verification_id: idSchema,
    revision,
    comment: str,
  }
  app.post(
    '/issues',
    {
      schema: schema(
        {
          task_id: idSchema,
          title: str,
          severity: props.severity,
          status: props.status,
          host: str,
          evidence_paths: list,
          reproduction: str,
        },
        ['task_id', 'title', 'severity'],
      ),
    },
    async (req: any, reply) => {
      const b = req.body,
        row = await task(req, b.task_id, 'write'),
        finder = await run(req, row.id)
      if (b.status === 'confirmed' || b.verification_id)
        fail(400, 'create candidate then verify')
      const id = randomUUID()
      const r = await pool.query(
        'INSERT INTO issues(id,task_id,title,severity,status,host,evidence_paths,reproduction,finder_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          id,
          row.id,
          b.title,
          b.severity,
          b.status ?? 'unverified',
          b.host ?? null,
          b.evidence_paths ?? [],
          b.reproduction ?? null,
          finder.id,
        ],
      )
      return reply.code(201).send(r.rows[0])
    },
  )
  app.get('/issues', async (req: any) => {
    const row = await task(req, req.query.task_id),
      limit = Number(req.query.limit ?? 50),
      offset = Number(req.query.offset ?? 0)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      fail(400, 'invalid pagination')
    const params: any[] = [row.id]
    const where = ['host', 'severity', 'status']
      .filter((k) => req.query[k] !== undefined)
      .map((k) => {
        params.push(req.query[k])
        return `${k}=$${params.length}`
      })
    params.push(limit, offset)
    const r = await pool.query(
      `SELECT * FROM issues WHERE task_id=$1 ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY created_at DESC,id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return {
      issues: r.rows,
      limit,
      offset,
      next_offset: r.rows.length === limit ? offset + limit : null,
    }
  })
  app.post(
    '/issues/:id/verifications',
    {
      schema: schema(
        {
          revision,
          outcome: { enum: ['confirmed', 'false_positive', 'inconclusive'] },
          evidence_paths: list,
        },
        ['revision', 'outcome', 'evidence_paths'],
      ),
    },
    async (req: any) => {
      const issue = (
        await pool.query('SELECT * FROM issues WHERE id=$1', [
          validId(req.params.id),
        ])
      ).rows[0]
      if (!issue) fail(404, 'issue not found')
      await task(req, issue.task_id, 'write')
      const verifier = await run(req, issue.task_id)
      if (verifier.role !== 'verifier' || verifier.id === issue.finder_run_id)
        fail(403, 'independent verifier required')
      if (!req.body.evidence_paths.length) fail(400, 'evidence required')
      return tx(async (c) => {
        const current = (
          await c.query('SELECT revision FROM issues WHERE id=$1 FOR UPDATE', [
            issue.id,
          ])
        ).rows[0]
        if (current.revision !== req.body.revision)
          fail(409, 'stale finding revision')
        const id = randomUUID()
        await c.query(
          'INSERT INTO issue_verifications(id,issue_id,issue_revision,verifier_run_id,outcome,evidence_paths) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            issue.id,
            current.revision,
            verifier.id,
            req.body.outcome,
            req.body.evidence_paths,
          ],
        )
        return {
          id,
          issue_id: issue.id,
          revision: current.revision,
          outcome: req.body.outcome,
        }
      })
    },
  )
  app.patch(
    '/issues/:id',
    {
      schema: schema(
        {
          title: str,
          severity: props.severity,
          status: props.status,
          host: str,
          evidence_paths: list,
          reproduction: str,
          verification_id: idSchema,
          revision,
          comment: str,
        },
        ['revision'],
      ),
    },
    async (req: any) => {
      const issue = (
        await pool.query('SELECT * FROM issues WHERE id=$1', [
          validId(req.params.id),
        ])
      ).rows[0]
      if (!issue) fail(404, 'issue not found')
      await task(req, issue.task_id, 'write')
      const actor = await run(req, issue.task_id),
        b = req.body
      if (b.task_id) fail(400, 'immutable ownership')
      return tx(async (c) => {
        const locked = (
          await c.query('SELECT * FROM issues WHERE id=$1 FOR UPDATE', [
            issue.id,
          ])
        ).rows[0]
        if (locked.revision !== b.revision) fail(409, 'stale issue revision')
        const substantive = [
          'title',
          'severity',
          'host',
          'evidence_paths',
          'reproduction',
        ].some((k) => b[k] !== undefined)
        if (substantive && b.status === 'confirmed')
          fail(409, 'candidate changes require fresh independent verification')
        if (substantive && locked.status === 'confirmed')
          b.status = 'unverified'
        if (b.status === 'confirmed') {
          const proof = await c.query(
            'SELECT id FROM issue_verifications WHERE id=$1 AND issue_id=$2 AND issue_revision=$3 AND outcome=$4',
            [b.verification_id ?? null, issue.id, b.revision, 'confirmed'],
          )
          if (!proof.rowCount)
            fail(403, 'current independent verification required')
        }
        const keys = [
          'title',
          'severity',
          'status',
          'host',
          'evidence_paths',
          'reproduction',
        ].filter((k) => b[k] !== undefined)
        let result = locked
        if (keys.length)
          result = (
            await c.query(
              `UPDATE issues SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')},revision=revision+1 WHERE id=$1 RETURNING *`,
              [issue.id, ...keys.map((k) => b[k])],
            )
          ).rows[0]
        if (!keys.length && !b.comment) fail(400, 'no changes')
        await c.query(
          'INSERT INTO issue_history(issue_id,actor,change) VALUES($1,$2,$3)',
          [issue.id, actor.id, JSON.stringify(b)],
        )
        return result
      })
    },
  )
  app.get('/issues/:id/history', async (req: any) => {
    const issue = (
      await pool.query('SELECT task_id FROM issues WHERE id=$1', [
        validId(req.params.id),
      ])
    ).rows[0]
    if (!issue) fail(404, 'issue not found')
    await task(req, issue.task_id)
    return {
      history: (
        await pool.query(
          'SELECT * FROM issue_history WHERE issue_id=$1 ORDER BY id LIMIT 100',
          [req.params.id],
        )
      ).rows,
    }
  })
  return app
}
async function main() {
  const sessionOpenToken = (
    await readFile(
      process.env.NEO_SESSION_OPEN_FILE || '/state/session-open.token',
      'utf8',
    )
  ).trim()
  if (!sessionOpenToken) throw new Error('session open token is empty')
  const app = await buildApp({ sessionOpenToken })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      app
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    })
  await app.listen({ port: Number(process.env.PORT ?? 8090), host: '0.0.0.0' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
