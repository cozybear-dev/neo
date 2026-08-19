import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import picomatch from 'picomatch'
import { createPool, migrate, type Db } from './db.js'

export type MemoryBody = {
  insights?: unknown[]
  facts?: unknown[]
  todos?: unknown[]
  files?: unknown[]
}

export type ScopeCheckBody = {
  target: string
  task_id?: string
}

export type CreateTaskBody = {
  id?: string
  mode: 'fast' | 'thorough'
  objective: string
  allowlist: string[]
  denylist?: string[]
  status?: string
}

export type CreateIssueBody = {
  task_id?: string
  title: string
  severity: string
  status?: 'unverified' | 'confirmed' | 'open' | 'false_positive'
  host?: string
  evidence_paths?: string[]
  reproduction?: string
  verdict?: string
}

export type PatchIssueBody = {
  status?: 'unverified' | 'confirmed' | 'open' | 'false_positive'
  title?: string
  severity?: string
  host?: string
  evidence_paths?: string[]
  reproduction?: string
  verdict?: string
}

export type AppOptions = {
  databaseUrl?: string
  allowlistEnv?: string
  pool?: Db
}

function parseAllowlistEnv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function matchPattern(patterns: string[], target: string): string | null {
  for (const pattern of patterns) {
    if (picomatch.isMatch(target, pattern, { nocase: true, dot: true })) {
      return pattern
    }
  }
  return null
}

export function checkScope(input: {
  target: string
  envAllowlist: string[]
  taskAllowlist?: string[]
  taskDenylist?: string[]
}): { allowed: boolean; matched: string; reason: string } {
  const target = input.target.trim()
  if (!target) {
    return { allowed: false, matched: '', reason: 'empty target' }
  }

  const denylist = input.taskDenylist ?? []
  const denied = matchPattern(denylist, target)
  if (denied) {
    return { allowed: false, matched: denied, reason: 'matched denylist' }
  }

  const allowlist = [...input.envAllowlist, ...(input.taskAllowlist ?? [])]
  if (allowlist.length === 0) {
    return { allowed: false, matched: '', reason: 'default deny: empty allowlist' }
  }

  const matched = matchPattern(allowlist, target)
  if (!matched) {
    return { allowed: false, matched: '', reason: 'default deny: no allowlist match' }
  }

  return { allowed: true, matched, reason: 'matched allowlist' }
}

const emptyMemory = {
  insights: [] as unknown[],
  facts: [] as unknown[],
  todos: [] as unknown[],
  files: [] as unknown[],
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const databaseUrl =
    opts.databaseUrl ?? process.env.DATABASE_URL ?? 'postgres://neo:neo@127.0.0.1:5432/neo'
  const envAllowlist = parseAllowlistEnv(
    opts.allowlistEnv ?? process.env.NEO_ALLOWLIST,
  )
  const pool = opts.pool ?? createPool(databaseUrl)
  await migrate(pool)

  const app = Fastify({ logger: false })

  app.addHook('onClose', async () => {
    if (!opts.pool) {
      await pool.end()
    }
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.post<{ Body: CreateTaskBody }>('/tasks', async (req, reply) => {
    const body = req.body
    if (!body || (body.mode !== 'fast' && body.mode !== 'thorough')) {
      return reply.code(400).send({ error: 'mode must be fast or thorough' })
    }
    if (typeof body.objective !== 'string' || !body.objective.trim()) {
      return reply.code(400).send({ error: 'objective is required' })
    }
    if (!Array.isArray(body.allowlist)) {
      return reply.code(400).send({ error: 'allowlist must be an array' })
    }

    const id = body.id && isUuid(body.id) ? body.id : randomUUID()
    const denylist = Array.isArray(body.denylist) ? body.denylist : []
    const status = typeof body.status === 'string' && body.status ? body.status : 'pending'

    await pool.query(
      `INSERT INTO tasks (id, mode, objective, allowlist, denylist, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, body.mode, body.objective, body.allowlist, denylist, status],
    )
    await pool.query(`INSERT INTO task_memory (task_id) VALUES ($1)`, [id])

    return reply.code(201).send({
      id,
      mode: body.mode,
      objective: body.objective,
      allowlist: body.allowlist,
      denylist,
      status,
    })
  })

  app.get<{ Params: { id: string } }>('/tasks/:id/memory', async (req, reply) => {
    const { id } = req.params
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid task id' })

    const task = await pool.query(`SELECT id FROM tasks WHERE id = $1`, [id])
    if (task.rowCount === 0) return reply.code(404).send({ error: 'task not found' })

    const mem = await pool.query(
      `SELECT insights, facts, todos, files, updated_at FROM task_memory WHERE task_id = $1`,
      [id],
    )
    if (mem.rowCount === 0) {
      return { task_id: id, ...emptyMemory }
    }
    const row = mem.rows[0]
    return {
      task_id: id,
      insights: row.insights,
      facts: row.facts,
      todos: row.todos,
      files: row.files,
      updated_at: row.updated_at,
    }
  })

  app.put<{ Params: { id: string }; Body: MemoryBody }>('/tasks/:id/memory', async (req, reply) => {
    const { id } = req.params
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid task id' })

    const task = await pool.query(`SELECT id FROM tasks WHERE id = $1`, [id])
    if (task.rowCount === 0) return reply.code(404).send({ error: 'task not found' })

    const body = req.body ?? {}
    const existing = await pool.query(
      `SELECT insights, facts, todos, files FROM task_memory WHERE task_id = $1`,
      [id],
    )

    const prev = existing.rows[0] ?? emptyMemory
    const next = {
      insights: Array.isArray(body.insights) ? body.insights : prev.insights,
      facts: Array.isArray(body.facts) ? body.facts : prev.facts,
      todos: Array.isArray(body.todos) ? body.todos : prev.todos,
      files: Array.isArray(body.files) ? body.files : prev.files,
    }

    const result = await pool.query(
      `INSERT INTO task_memory (task_id, insights, facts, todos, files, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())
       ON CONFLICT (task_id) DO UPDATE SET
         insights = EXCLUDED.insights,
         facts = EXCLUDED.facts,
         todos = EXCLUDED.todos,
         files = EXCLUDED.files,
         updated_at = now()
       RETURNING insights, facts, todos, files, updated_at`,
      [
        id,
        JSON.stringify(next.insights),
        JSON.stringify(next.facts),
        JSON.stringify(next.todos),
        JSON.stringify(next.files),
      ],
    )

    const row = result.rows[0]
    return {
      task_id: id,
      insights: row.insights,
      facts: row.facts,
      todos: row.todos,
      files: row.files,
      updated_at: row.updated_at,
    }
  })

  app.post<{ Body: CreateIssueBody }>('/issues', async (req, reply) => {
    const body = req.body
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return reply.code(400).send({ error: 'title is required' })
    }
    if (typeof body.severity !== 'string' || !body.severity.trim()) {
      return reply.code(400).send({ error: 'severity is required' })
    }

    let mode: 'fast' | 'thorough' | null = null
    if (body.task_id) {
      if (!isUuid(body.task_id)) {
        return reply.code(400).send({ error: 'invalid task_id' })
      }
      const task = await pool.query(`SELECT mode FROM tasks WHERE id = $1`, [body.task_id])
      if (task.rowCount === 0) {
        return reply.code(404).send({ error: 'task not found' })
      }
      mode = task.rows[0].mode
    }

    const verdict = typeof body.verdict === 'string' ? body.verdict : undefined

    // Thorough path requires verdict === 'confirmed'. Fast may file unverified.
    if (mode === 'thorough' && verdict !== 'confirmed') {
      return reply.code(400).send({
        error: 'thorough mode requires verdict=confirmed',
      })
    }

    let status = body.status
    if (!status) {
      if (verdict === 'confirmed') status = 'confirmed'
      else if (mode === 'fast') status = 'unverified'
      else status = 'unverified'
    }

    if (!['unverified', 'confirmed', 'open', 'false_positive'].includes(status)) {
      return reply.code(400).send({ error: 'invalid status' })
    }

    // Even without a task, reject non-confirmed when caller claims thorough via verdict rules:
    // if no task_id, still allow unverified (fast-style) unless status forced to confirmed without verdict.
    if (status === 'confirmed' && verdict !== 'confirmed') {
      return reply.code(400).send({ error: 'status confirmed requires verdict=confirmed' })
    }

    const id = randomUUID()
    const evidence = Array.isArray(body.evidence_paths) ? body.evidence_paths : []

    await pool.query(
      `INSERT INTO issues
         (id, task_id, title, severity, status, host, evidence_paths, reproduction, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        body.task_id ?? null,
        body.title,
        body.severity,
        status,
        body.host ?? null,
        evidence,
        body.reproduction ?? null,
        verdict ?? null,
      ],
    )

    return reply.code(201).send({
      id,
      task_id: body.task_id ?? null,
      title: body.title,
      severity: body.severity,
      status,
      host: body.host ?? null,
      evidence_paths: evidence,
      reproduction: body.reproduction ?? null,
      verdict: verdict ?? null,
    })
  })

  app.get<{
    Querystring: { host?: string; severity?: string; status?: string; task_id?: string }
  }>('/issues', async (req) => {
    const { host, severity, status, task_id } = req.query
    const clauses: string[] = []
    const params: unknown[] = []

    if (host) {
      params.push(host)
      clauses.push(`host = $${params.length}`)
    }
    if (severity) {
      params.push(severity)
      clauses.push(`severity = $${params.length}`)
    }
    if (status) {
      params.push(status)
      clauses.push(`status = $${params.length}`)
    }
    if (task_id) {
      params.push(task_id)
      clauses.push(`task_id = $${params.length}`)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const result = await pool.query(
      `SELECT id, task_id, title, severity, status, host, evidence_paths, reproduction, verdict, created_at
       FROM issues ${where}
       ORDER BY created_at DESC`,
      params,
    )
    return { issues: result.rows }
  })

  app.patch<{ Params: { id: string }; Body: PatchIssueBody }>('/issues/:id', async (req, reply) => {
    const { id } = req.params
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid issue id' })

    const existing = await pool.query(`SELECT * FROM issues WHERE id = $1`, [id])
    if (existing.rowCount === 0) return reply.code(404).send({ error: 'issue not found' })

    const body = req.body ?? {}
    const row = existing.rows[0]
    const next = {
      title: typeof body.title === 'string' ? body.title : row.title,
      severity: typeof body.severity === 'string' ? body.severity : row.severity,
      status: body.status ?? row.status,
      host: body.host !== undefined ? body.host : row.host,
      evidence_paths: Array.isArray(body.evidence_paths) ? body.evidence_paths : row.evidence_paths,
      reproduction: body.reproduction !== undefined ? body.reproduction : row.reproduction,
      verdict: body.verdict !== undefined ? body.verdict : row.verdict,
    }

    if (!['unverified', 'confirmed', 'open', 'false_positive'].includes(next.status)) {
      return reply.code(400).send({ error: 'invalid status' })
    }

    const updated = await pool.query(
      `UPDATE issues SET
         title = $2,
         severity = $3,
         status = $4,
         host = $5,
         evidence_paths = $6,
         reproduction = $7,
         verdict = $8
       WHERE id = $1
       RETURNING id, task_id, title, severity, status, host, evidence_paths, reproduction, verdict, created_at`,
      [
        id,
        next.title,
        next.severity,
        next.status,
        next.host,
        next.evidence_paths,
        next.reproduction,
        next.verdict,
      ],
    )

    return updated.rows[0]
  })

  app.post<{ Body: ScopeCheckBody }>('/scope/check', async (req, reply) => {
    const body = req.body
    if (!body || typeof body.target !== 'string') {
      return reply.code(400).send({ error: 'target is required' })
    }

    let taskAllowlist: string[] | undefined
    let taskDenylist: string[] | undefined

    if (body.task_id) {
      if (!isUuid(body.task_id)) {
        return reply.code(400).send({ error: 'invalid task_id' })
      }
      const task = await pool.query(
        `SELECT allowlist, denylist FROM tasks WHERE id = $1`,
        [body.task_id],
      )
      if (task.rowCount === 0) {
        return reply.code(404).send({ error: 'task not found' })
      }
      taskAllowlist = task.rows[0].allowlist
      taskDenylist = task.rows[0].denylist
    }

    return checkScope({
      target: body.target,
      envAllowlist,
      taskAllowlist,
      taskDenylist,
    })
  })

  return app
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

async function main() {
  const port = Number(process.env.PORT ?? 8090)
  const app = await buildApp()
  await app.listen({ port, host: '0.0.0.0' })
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
