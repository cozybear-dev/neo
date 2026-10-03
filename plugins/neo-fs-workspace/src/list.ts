export interface FsTarget {
  targetKey: string
  displayPath: string
}

export interface ListedEntry {
  name: string
  type: string
  size?: number
}

export interface ListResult {
  path: string
  entries: ListedEntry[]
}

export interface WorkspaceFs {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<ListedEntry[]>
}

/** One directory level. A file path tells the caller to use read. */
export async function listDirectory(
  path: string,
  fs: WorkspaceFs,
  signal?: AbortSignal,
): Promise<ListResult> {
  if (path.trim().length === 0) throw new Error('path must be a non-empty string')
  const target = await fs.resolve(path, signal ? { signal } : undefined)
  const info = await fs.stat(target, signal)
  const display = target.displayPath
  if (!info) throw new Error(`cannot list "${display}": not found`)
  if (info.type === 'file') {
    throw new Error(`cannot list "${display}": not a directory; use read for file contents`)
  }
  if (info.type !== 'directory') throw new Error(`cannot list "${display}": not a directory`)
  const entries = await fs.listDir(target, signal)
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  return {
    path: display,
    entries: sorted.map((entry) => ({
      name: entry.name,
      type: entry.type,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    })),
  }
}

export function renderList(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const result = value as ListResult
  const text = result.entries.map((entry) => (
    entry.size === undefined
      ? `${entry.name} ${entry.type}`
      : `${entry.name} ${entry.type} ${entry.size}`
  )).join('\n')
  return [{ type: 'text', text }]
}
