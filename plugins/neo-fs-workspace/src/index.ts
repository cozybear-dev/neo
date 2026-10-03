import { chmodSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceFs } from './list.ts'
import {
  type FsTarget,
  registerWorkspacePrompt,
  relaxObservedFile,
  workspaceRoot,
  type PromptApi,
} from './mode.ts'
import { createTools } from './tools.ts'

export const name = 'neo-fs-workspace'
export const inject = ['fs', 'tools']
export { createTools } from './tools.ts'

export function apply(ctx: Context): void {
  const root = workspaceRoot(process.env)
  ctx.on('fs/observed', (target: FsTarget, observation: { kind: string }) => {
    relaxObservedFile(target, observation, {
      workspaceRoot: root,
      processPath: (entry) => ctx.fs.processPath(entry),
      stat: (path) => statSync(path),
      chmod: (path, mode) => chmodSync(path, mode),
    })
  })

  const promptApi = ctx.get('systemPrompt') as PromptApi | undefined
  registerWorkspacePrompt(promptApi)

  const fs: WorkspaceFs = {
    resolve: (path, opts) => ctx.fs.resolve(path, opts),
    stat: (target, signal) => ctx.fs.stat(target, signal),
    listDir: (target, signal) => ctx.fs.listDir(target, signal),
  }
  for (const def of createTools(fs)) ctx.tools.register(defineTool(def))
}
