import { listDirectory, renderList, type WorkspaceFs } from './list.ts'

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (
    args: Record<string, unknown>,
    exec: { signal?: AbortSignal; agent?: unknown },
  ) => unknown | Promise<unknown>
}

export function createTools(fs: WorkspaceFs): ToolDef[] {
  return [{
    name: 'list_dir',
    description:
      'List one directory level: name, type, and size for files. Does not read file contents and does not recurse. read of a directory fails with FS_NOT_REGULAR_FILE; use read for a regular file.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Directory to list, resolved by the filesystem backend.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                size: { type: 'number' },
              },
            },
          },
        },
      },
      render: renderList,
    },
    async execute(args, exec) {
      return listDirectory(String(args.path ?? ''), fs, exec.signal)
    },
  }]
}
