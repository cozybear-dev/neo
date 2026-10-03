declare const process: {
  env: Record<string, string | undefined>
  cwd: () => string
}

declare module 'node:crypto' {
  export function randomUUID(): string
}

declare module 'node:fs' {
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, enc: string): string
  export function mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void
  export function chmodSync(path: string, mode: number): void
  export function writeFileSync(path: string, data: string, enc?: string): void
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: unknown
      render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }
    execute: (
      args: Record<string, unknown>,
      exec: { signal?: AbortSignal; agent?: unknown },
    ) => unknown | Promise<unknown>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register: (tool: unknown) => void
      schemas?: (scope?: unknown) => Array<{ name?: string }>
    }
    get(name: string): unknown
    subagents?: SubagentsLike
    systemPrompt?: {
      section: (opts: {
        name: string
        order?: number
        // Assembly passes { agent, scope: agent }. scope is the live agent,
        // which catalogSectionText reads for options.neoAgentId.
        text: string | ((context: { scope?: unknown; agent?: unknown }) => string)
      }) => void
    }
  }
}

interface SubagentsLike {
  start: (name: string, request: Record<string, unknown>) => Promise<SubagentRunLike>
}

interface SubagentRunLike {
  id?: string
  localAgent?: unknown
  result: Promise<{
    structured?: unknown
    output?: Array<{ type?: string; text?: string }>
    stopReason?: string
    diagnostic?: string
  }>
  dispose: () => Promise<void>
}
