import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTools } from './tools.ts'

export const name = 'neo-sandbox-docker'
export const inject = ['tools']
export { createTools } from './tools.ts'

// Pin 141eb6f ctx.subprocess / ctx.fs need SubprocessRuntime (PTY, mux collect,
// resolveExecutable, tree terminate) and FileSystem policy events. Those seams
// are not swapped: built-in bash/fs stay local to dsh. sandbox_exec docker-execs
// into SANDBOX_CONTAINER (default neo-sandbox-1). Shared /workspace is the file bus.

export function apply(ctx: Context): void {
  for (const def of createTools()) ctx.tools.register(defineTool(def))
}
