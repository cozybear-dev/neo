declare const process: { env: Record<string, string | undefined> }

declare module 'node:fs' {
  export function realpathSync(path: string): string
  export function statSync(path: string): {
    isFile: () => boolean
    mode: number
  }
  export function chmodSync(path: string, mode: number): void
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function resolve(...paths: string[]): string
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
      exec: { signal?: AbortSignal; agent?: unknown },
    ) => unknown | Promise<unknown>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register: (tool: unknown) => void
      guard: (
        guard: (exec: {
          name: string
          arguments: unknown
        }) => string | undefined,
      ) => () => void
    }
    get(name: string): unknown
    on(
      event: 'fs/observed',
      listener: (
        target: { targetKey: string; displayPath: string },
        observation: { kind: string },
      ) => void,
    ): void
    fs: {
      processPath(target: { targetKey: string; displayPath: string }): string
      resolve(
        path: string,
        opts?: { signal?: AbortSignal },
      ): Promise<{ targetKey: string; displayPath: string }>
      stat(
        target: { targetKey: string; displayPath: string },
        signal?: AbortSignal,
      ): Promise<{ type: string; size?: number } | undefined>
      listDir(
        target: { targetKey: string; displayPath: string },
        signal?: AbortSignal,
      ): Promise<Array<{ name: string; type: string; size?: number }>>
    }
  }
}
