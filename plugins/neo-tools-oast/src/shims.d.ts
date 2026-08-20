declare const process: { env: Record<string, string | undefined> }

type Buffer = {
  toString(enc?: string): string
  subarray(start: number, end?: number): Buffer
  length: number
  [index: number]: number
}

declare const Buffer: {
  from(data: string | Uint8Array, enc?: string): Buffer
  concat(list: Buffer[]): Buffer
}

declare module 'node:crypto' {
  export const constants: { RSA_PKCS1_OAEP_PADDING: number }
  export function generateKeyPairSync(
    type: 'rsa',
    options: {
      modulusLength: number
      publicKeyEncoding: { type: string; format: string }
      privateKeyEncoding: { type: string; format: string }
    },
  ): { publicKey: Buffer; privateKey: string }
  export function privateDecrypt(options: object, buffer: Buffer): Buffer
  export function publicEncrypt(options: object, buffer: Buffer | string): Buffer
  export function createDecipheriv(
    alg: string,
    key: Buffer,
    iv: Buffer,
  ): { update(data: Buffer): Buffer; final(): Buffer }
  export function createCipheriv(
    alg: string,
    key: Buffer,
    iv: Buffer,
  ): { update(data: string, input: string): Buffer; final(): Buffer }
  export function randomBytes(size: number): Buffer
  export function randomUUID(): string
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
