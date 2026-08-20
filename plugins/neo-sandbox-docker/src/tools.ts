import { execInSandbox, renderSafe, type ClientOptions } from './client.ts'

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

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [{
    name: 'sandbox_exec',
    description:
      'Run a shell command inside the sandbox container via docker exec. cwd is /workspace unless overridden. Does not replace DSH built-in bash; use this for sandbox toolchain binaries (nuclei, nmap, …). Never echo secrets.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command passed to bash -lc.' },
      cwd: { type: 'string', description: 'Working directory inside the sandbox (default /workspace).' },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Extra environment variables for the exec. String values only; not rendered.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'number', required: true },
        },
      },
      render: renderSafe,
    },
    async execute(args, exec) {
      const envArg = args.env && typeof args.env === 'object' && !Array.isArray(args.env)
        ? Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
        : undefined
      return execInSandbox(
        {
          command: String(args.command ?? ''),
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
          env: envArg,
        },
        { ...options, signal: exec.signal },
      )
    },
  }]
}
