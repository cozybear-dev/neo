declare const process: { env: Record<string, string | undefined> }

type Buffer = {
  toString(enc?: string): string
  length: number
}

declare const Buffer: {
  from(data: string | Uint8Array, enc?: string): Buffer
  concat(list: Buffer[]): Buffer
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(enc: string): string }
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>
  export function readFile(path: string, enc?: string): Promise<string>
  export function appendFile(path: string, data: string): Promise<void>
  export function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module 'node:child_process' {
  export function spawn(
    command: string,
    args: string[],
    opts?: {
      signal?: AbortSignal
      env?: Record<string, string | undefined>
      cwd?: string
    },
  ): {
    stdout: { on(event: string, cb: (chunk: Buffer) => void): void }
    stderr: { on(event: string, cb: (chunk: Buffer) => void): void }
    on(event: string, cb: (...args: never[]) => void): void
  }
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
      exec: { signal: AbortSignal },
    ) => unknown | Promise<unknown>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: { register: (tool: unknown) => void }
  }
}
