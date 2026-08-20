declare const process: { env: Record<string, string | undefined> }

type Buffer = {
  toString(enc?: string): string
  subarray(start: number, end?: number): Buffer
  length: number
  readUInt32BE(offset: number): number
  [index: number]: number
}

declare const Buffer: {
  from(data: string | Uint8Array | number[], enc?: string): Buffer
  concat(list: Buffer[]): Buffer
  byteLength(data: string): number
}

declare module 'node:child_process' {
  export function spawn(
    command: string,
    args: string[],
    options?: {
      signal?: AbortSignal
      env?: Record<string, string | undefined>
      windowsHide?: boolean
    },
  ): {
    stdout: { on(event: 'data', fn: (chunk: Buffer) => void): void } | null
    stderr: { on(event: 'data', fn: (chunk: Buffer) => void): void } | null
    on(event: 'error', fn: (err: Error) => void): void
    on(event: 'close', fn: (code: number | null) => void): void
    kill(signal?: string): boolean
  }
}

declare module 'node:http' {
  export function request(
    options: {
      socketPath?: string
      host?: string
      port?: number
      path: string
      method?: string
      headers?: Record<string, string | number>
      signal?: AbortSignal
    },
    callback?: (res: {
      statusCode?: number
      headers: Record<string, string | string[] | undefined>
      on(event: 'data', fn: (chunk: Buffer) => void): void
      on(event: 'end', fn: () => void): void
      on(event: 'error', fn: (err: Error) => void): void
    }) => void,
  ): {
    on(event: 'error', fn: (err: Error) => void): void
    write(chunk: string | Buffer): void
    end(): void
    destroy(err?: Error): void
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
