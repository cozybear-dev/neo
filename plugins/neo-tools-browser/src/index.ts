import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTools } from './tools.ts'

export const name = 'neo-tools-browser'
export const inject = ['tools']
export { createTools } from './tools.ts'

export function apply(ctx: Context): void {
  for (const def of createTools()) ctx.tools.register(defineTool(def))
}
