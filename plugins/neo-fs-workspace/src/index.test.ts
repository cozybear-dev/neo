import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertExecuteResultValid } from '../../../tests/helpers/dsh-schema.ts'
import { listDirectory } from './list.ts'
import {
  isUnderWorkspace,
  relaxObservedFile,
  withGroupOtherRead,
  workspaceRoot,
  WORKSPACE_PROMPT,
  type ModeDeps,
} from './mode.ts'
import { createTools } from './tools.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('workspace file mode', () => {
  it('adds group and other read to owner-only files', () => {
    assert.equal(withGroupOtherRead(0o600), 0o644)
    assert.equal(withGroupOtherRead(0o700), 0o744)
  })

  it('leaves a mode that is already group- and world-readable unchanged', () => {
    assert.equal(withGroupOtherRead(0o755), 0o755)
    assert.equal(withGroupOtherRead(0o644), 0o644)
  })

  it('treats NEO_WORKSPACE as the root and ignores a lookalike prefix', () => {
    assert.equal(workspaceRoot({}), '/workspace')
    assert.equal(workspaceRoot({ NEO_WORKSPACE: '/tmp/ws/' }), '/tmp/ws')
    assert.equal(isUnderWorkspace('/workspace', '/workspace/agents/a.md'), true)
    assert.equal(isUnderWorkspace('/workspace', '/workspace'), true)
    assert.equal(isUnderWorkspace('/workspace', '/workspace-backup/a.md'), false)
    assert.equal(isUnderWorkspace('/workspace', '/etc/passwd'), false)
  })

  it('chmods a regular file under the workspace when group or other read is missing', () => {
    const calls: Array<[string, number]> = []
    const { target, observation } = present('/workspace/agents/a.md')
    relaxObservedFile(target, observation, deps({
      chmod: (path, mode) => calls.push([path, mode]),
    }))
    assert.deepEqual(calls, [['/workspace/agents/a.md', 0o644]])
  })

  it('does not chmod directories, files outside the workspace, or absent observations', () => {
    const calls: string[] = []
    const chmod = (path: string) => calls.push(path)
    const directory = present('/workspace')
    relaxObservedFile(directory.target, directory.observation, deps({
      processPath: () => '/workspace',
      stat: () => ({ isFile: () => false, mode: 0o777 }),
      chmod,
    }))
    const link = present('/workspace/link')
    relaxObservedFile(link.target, link.observation, deps({
      processPath: () => '/etc/passwd',
      stat: () => ({ isFile: () => true, mode: 0o600 }),
      chmod,
    }))
    relaxObservedFile(
      { targetKey: '/workspace/a.md', displayPath: '/workspace/a.md' },
      { kind: 'absent' },
      deps({ chmod }),
    )
    assert.deepEqual(calls, [])
  })

  it('swallows stat and chmod failures', () => {
    const file = present('/workspace/a.md')
    assert.doesNotThrow(() => relaxObservedFile(file.target, file.observation, deps({
      stat: () => { throw new Error('stat failed') },
    })))
    assert.doesNotThrow(() => relaxObservedFile(file.target, file.observation, deps({
      chmod: () => { throw new Error('chmod failed') },
    })))
  })
})

describe('list_dir', () => {
  it('lists one directory level sorted by name', async () => {
    const tool = createTools(fakeFs())[0]
    const value = await tool.execute({ path: '/workspace' }, exec())
    assert.deepEqual(value, {
      path: '/workspace',
      entries: [
        { name: 'a.md', type: 'file', size: 12 },
        { name: 'nested', type: 'directory' },
      ],
    })
    assert.equal(tool.output.render({}, value)[0]?.text, 'a.md file 12\nnested directory')
    assertExecuteResultValid(tool, value)
  })

  it('tells the caller to use read when the path is a file', async () => {
    const tool = createTools(fakeFs())[0]
    await assert.rejects(
      () => tool.execute({ path: '/workspace/a.md' }, exec()),
      /use read/,
    )
  })

  it('errors when the path is missing or blank', async () => {
    const tool = createTools(fakeFs())[0]
    await assert.rejects(
      () => tool.execute({ path: '/workspace/missing' }, exec()),
      /not found/,
    )
    await assert.rejects(
      () => listDirectory('   ', fakeFs()),
      /non-empty/,
    )
  })
})

describe('plugin wiring', () => {
  it('states that read of a directory fails and list_dir is the listing tool', () => {
    assert.match(WORKSPACE_PROMPT, /FS_NOT_REGULAR_FILE/)
    assert.match(WORKSPACE_PROMPT, /list_dir/)
  })

  it('hooks fs/observed and registers the prompt without reading ctx.systemPrompt', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8')
    assert.match(src, /fs\/observed/)
    assert.match(src, /relaxObservedFile/)
    assert.match(src, /registerWorkspacePrompt/)
    assert.doesNotMatch(src, /ctx\.systemPrompt\b/)
    assert.match(src, /ctx\.get\(\s*['"]systemPrompt['"]\s*\)/)
  })
})

function present(displayPath: string) {
  return {
    target: { targetKey: displayPath, displayPath },
    observation: { kind: 'present' as const },
  }
}

function deps(overrides: Partial<ModeDeps> = {}): ModeDeps {
  return {
    workspaceRoot: '/workspace',
    processPath: (target) => target.displayPath,
    stat: () => ({ isFile: () => true, mode: 0o600 }),
    chmod: () => {},
    ...overrides,
  }
}

function exec() {
  return { signal: new AbortController().signal }
}

function fakeFs() {
  return {
    async resolve(path: string) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target: { displayPath: string }) {
      if (target.displayPath === '/workspace') return { type: 'directory' as const }
      if (target.displayPath === '/workspace/a.md') return { type: 'file' as const, size: 12 }
      return undefined
    },
    async listDir() {
      return [
        { name: 'nested', type: 'directory' as const },
        { name: 'a.md', type: 'file' as const, size: 12 },
      ]
    },
  }
}
