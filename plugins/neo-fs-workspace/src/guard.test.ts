import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { workspaceGuard } from './guard.ts'

test('file guard confines read and write including symlinks and missing descendants', () => {
  const base = mkdtempSync(join(tmpdir(), 'neo-guard-'))
  const root = join(base, 'task')
  const skills = join(base, 'skills')
  mkdirSync(root)
  mkdirSync(skills)
  const guard = workspaceGuard(root, [skills])
  const call = (name: string, path: string) =>
    guard({ name, arguments: { file_path: path } })
  try {
    assert.equal(call('write', 'new/deep/file.txt'), undefined)
    assert.ok(call('read', '../secret'))
    assert.ok(call('read', '/proc/self/environ'))
    assert.equal(call('read_image', 'browser/screenshot.png'), undefined)
    assert.ok(call('read_image', '../other-task/screenshot.png'))
    assert.ok(call('write', `${root}-other/file`))
    symlinkSync(base, join(root, 'escape'))
    assert.ok(call('write', 'escape/new/file'))
    assert.equal(call('read', join(skills, 'guide.md')), undefined)
    assert.ok(call('write', join(skills, 'guide.md')))
    for (const name of ['bash', 'web_fetch', 'spawn_agent', 'unknown'])
      assert.ok(guard({ name, arguments: {} }))
    for (const name of ['delegate', 'sandbox_exec', 'run_code'])
      assert.equal(guard({ name, arguments: {} }), undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
