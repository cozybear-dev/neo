/** Shown to every agent: directory reads fail; list one level with list_dir. */
export const WORKSPACE_PROMPT = [
  'read and write require a regular file.',
  'read of a directory fails with FS_NOT_REGULAR_FILE.',
  'Use list_dir to list one directory level.',
].join(' ')

export interface FsTarget {
  targetKey: string
  displayPath: string
}

export interface ModeDeps {
  workspaceRoot: string
  processPath: (target: FsTarget) => string
  stat: (path: string) => { isFile: () => boolean; mode: number }
  chmod: (path: string, mode: number) => void
}

export interface PromptApi {
  section: (opts: { name: string; order?: number; text: string }) => void
}

/** Shared volume root. A trailing slash is stripped so prefix checks stay exact. */
export function workspaceRoot(env: Record<string, string | undefined>): string {
  const raw = env.NEO_WORKSPACE?.trim()
  const value = raw ? raw : '/workspace'
  if (value.length > 1 && value.endsWith('/')) return value.replace(/\/+$/, '')
  return value
}

/** True for the workspace root and its descendants, not for a lookalike prefix. */
export function isUnderWorkspace(root: string, realPath: string): boolean {
  return realPath === root || realPath.startsWith(`${root}/`)
}

/**
 * Keep owner/group access, add group read, and remove all world permissions.
 * Executable files stay executable for their owner/group.
 */
export function withGroupOtherRead(mode: number): number {
  return (mode & 0o770) | 0o040
}

/**
 * After a harness read, write, or edit, make a regular file under the workspace
 * readable by the sandbox user. fs/observed listeners must not throw.
 */
export function relaxObservedFile(
  target: FsTarget,
  observation: { kind: string },
  deps: ModeDeps,
): void {
  try {
    if (observation.kind !== 'present') return
    const realPath = deps.processPath(target)
    if (!isUnderWorkspace(deps.workspaceRoot, realPath)) return
    const info = deps.stat(realPath)
    if (!info.isFile()) return
    const perm = info.mode & 0o777
    if ((perm & 0o047) === 0o040) return
    deps.chmod(realPath, withGroupOtherRead(perm))
  } catch {
    // A throwing listener fails the tool call after the mutation succeeded.
  }
}

export function registerWorkspacePrompt(api: PromptApi | undefined): void {
  if (!api || typeof api.section !== 'function') return
  api.section({
    name: 'neo:fs-workspace',
    order: 40,
    text: WORKSPACE_PROMPT,
  })
}
