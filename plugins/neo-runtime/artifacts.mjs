import { mkdir, open, realpath } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

export function taskWorkspace(env = process.env, taskId = env.NEO_TASK_ID) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      taskId || '',
    )
  )
    throw new Error('valid bound task id is required for artifacts')
  const root = resolve(env.NEO_WORKSPACE_BASE || '/workspace')
  return join(root, 'tasks', taskId.toLowerCase())
}

export async function persistRawArtifact(
  text,
  { root, kind = 'tool-output' } = {},
) {
  const base = resolve(root || taskWorkspace())
  if (!/^[a-z0-9-]+$/.test(kind)) throw new Error('invalid artifact kind')
  const dir = join(base, 'evidence', kind)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  const actual = await realpath(dir)
  const rel = relative(await realpath(base), actual)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('artifact directory escapes workspace')
  const path = join(actual, `${randomUUID()}.txt`)
  const file = await open(path, 'wx', 0o640)
  try {
    await file.writeFile(text, 'utf8')
  } finally {
    await file.close()
  }
  return path
}
