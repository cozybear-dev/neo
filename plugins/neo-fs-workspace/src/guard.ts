import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const safeTools = new Set([
  'skill',
  'run_code',
  'structured_output',
  'ask_user_question',
  'web_search',
  'delegate',
  'scope_check',
  'memory_get',
  'memory_update',
  'task_update',
  'task_get',
  'plan_submit',
  'verification_record',
  'issue_create',
  'issue_query',
  'issue_update',
  'oast_register',
  'oast_poll',
  'oast_deregister',
  'sandbox_exec',
  'browser_navigate',
  'browser_act',
  'browser_eval',
  'browser_screenshot',
  'browser_network',
  'traffic_search',
  'traffic_replay',
  'deploy_up',
  'deploy_down',
])
const fileTools = new Set([
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
  'list_dir',
])
const readonlyTools = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'list_dir',
])

/** Resolve existing ancestors too: a symlink must not grant access outside a root. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(
      canonical(parent),
      path.slice(parent.length + (parent.endsWith('/') ? 0 : 1)),
    )
  }
}
const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}/`)

/** Monotonic harness guard applies to direct calls and nested programmatic calls. */
export function workspaceGuard(
  root: string,
  readRoots: string[] = ['/opt/neo/skills', '/opt/neo/workflows'],
) {
  return (exec: { name: string; arguments: unknown }): string | undefined => {
    if (safeTools.has(exec.name)) return undefined
    if (!fileTools.has(exec.name))
      return `Neo blocks ${exec.name}; use task-authorized Neo tools.`
    const args = exec.arguments as Record<string, unknown> | undefined
    const raw = args?.file_path ?? args?.path ?? '.'
    if (
      typeof raw !== 'string' ||
      !raw.trim() ||
      raw.includes('\0') ||
      raw.startsWith('~')
    )
      return 'Invalid workspace path'
    try {
      const path = canonical(resolve(root, raw))
      if (inside(canonical(root), path)) return undefined
      if (
        readonlyTools.has(exec.name) &&
        readRoots.some((base) => inside(canonical(base), path))
      )
        return undefined
    } catch {
      return 'Cannot safely resolve workspace path'
    }
    return 'File access is limited to this task workspace and read-only Neo skills/workflows.'
  }
}
