import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterAllowlist } from '../../plugins/neo-orchestrator/src/delegate.ts'
import { getPreset, loadPresetsFromDir, resolvePresetsDir } from '../../plugins/neo-orchestrator/src/presets.ts'
import { taskIdFromSession } from '../../plugins/neo-tools-memory/src/task.ts'
import { normalizeScopeHost } from '../../plugins/neo-tools-scope/src/host.ts'

const presets = loadPresetsFromDir(resolvePresetsDir())

describe('session-ef2b412d regressions', () => {
  it('research keep-list survives a plugin-only host catalog', () => {
    const pluginOnly = ['memory_get', 'memory_update', 'sandbox_exec', 'scope_check']
    const parentVisible = [...pluginOnly, 'read', 'write', 'glob', 'grep', 'web_search', 'skill']
    const allow = filterAllowlist(getPreset(presets, 'research').tool_allowlist, pluginOnly, parentVisible)
    assert.deepEqual(
      ['read', 'write', 'glob', 'grep', 'web_search'].every((n) => allow.includes(n)),
      true,
    )
  })

  it('judge YAML still lists read/glob/grep', () => {
    const judge = getPreset(presets, 'judge')
    assert.ok(judge.tool_allowlist.includes('read'))
    assert.ok(judge.tool_allowlist.includes('glob'))
    assert.ok(judge.tool_allowlist.includes('grep'))
  })

  it('judge keep-list survives plugin-only known via parentVisible', () => {
    // Live judge child advertised only plugin/agent-plane tools, not DSH builtins.
    const pluginOnly = ['delegate', 'issue_query', 'memory_get', 'structured_output']
    const parentVisible = [...pluginOnly, 'read', 'glob', 'grep']
    const allow = filterAllowlist(getPreset(presets, 'judge').tool_allowlist, pluginOnly, parentVisible)
    assert.deepEqual(
      ['read', 'glob', 'grep'].every((n) => allow.includes(n)),
      true,
    )
  })

  it('https://huntandhackett.com is in scope when apex is allowlisted', () => {
    assert.equal(normalizeScopeHost('https://huntandhackett.com/path'), 'huntandhackett.com')
  })

  it('DSH session ids map to control task UUIDs', () => {
    assert.equal(
      taskIdFromSession('session-ef2b412d-84ac-4cde-8330-bdfd04154c78'),
      'ef2b412d-84ac-4cde-8330-bdfd04154c78',
    )
  })
})
