declare const process: { env: Record<string, string | undefined> }

type Buffer = {
  toString(enc?: string): string
  length: number
}

declare const Buffer: {
  alloc(
    size: number,
  ): Uint8Array & {
    subarray(
      start: number,
      end: number,
    ): Uint8Array & { toString(enc?: string): string }
  }
  byteLength(data: string): number
  from(data: string | Uint8Array, enc?: string): Buffer
}

declare module 'node:fs/promises' {
  export function open(
    path: string,
    flags: string,
  ): Promise<{
    stat(): Promise<{ size: number }>
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
  export function mkdir(
    path: string,
    opts?: { recursive?: boolean; mode?: number },
  ): Promise<void>
  export function writeFile(
    path: string,
    data: string | Uint8Array,
    opts?: { mode?: number },
  ): Promise<void>
  export function readFile(path: string, enc?: string): Promise<string>
  export function appendFile(
    path: string,
    data: string,
    opts?: { mode?: number },
  ): Promise<void>
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: unknown
      render: (
        args: unknown,
        value: unknown,
      ) => Array<{ type: string; text: string }>
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
