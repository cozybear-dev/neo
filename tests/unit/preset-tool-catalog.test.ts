import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadPresetsFromDir, resolvePresetsDir } from '../../plugins/neo-orchestrator/src/presets.ts'
import { filterAllowlist } from '../../plugins/neo-orchestrator/src/delegate.ts'
import { DSH_BUILTIN_TOOLS, NEO_TOOL_NAMES } from '../helpers/tool-catalog.ts'

const catalog = new Set<string>([...NEO_TOOL_NAMES, ...DSH_BUILTIN_TOOLS])

describe('preset tool allowlists', () => {
  it('every allowlist name is a Neo tool or a shipped DSH builtin', () => {
    const presets = loadPresetsFromDir(resolvePresetsDir())
    const unknown: string[] = []
    for (const preset of presets.values()) {
      for (const name of preset.tool_allowlist) {
        if (!catalog.has(name)) unknown.push(`${preset.id}:${name}`)
      }
    }
    assert.deepEqual(unknown, [])
  })

  it('does not list web_fetch (Exa profile ships web_search only)', () => {
    const presets = loadPresetsFromDir(resolvePresetsDir())
    for (const preset of presets.values()) {
      assert.equal(preset.tool_allowlist.includes('web_fetch'), false, preset.id)
    }
  })

  it('filterAllowlist drops names missing from the live host catalog', () => {
    const live = new Set(['delegate', 'web_search', 'read', 'write'])
    const allow = filterAllowlist(['web_search', 'web_fetch', 'read', 'not_a_tool'], live)
    assert.deepEqual(allow, ['web_search', 'read'])
  })

  it('filterAllowlist keeps the yaml list when the host catalog is unknown', () => {
    assert.deepEqual(
      filterAllowlist(['web_search', 'web_fetch'], undefined),
      ['web_search', 'web_fetch'],
    )
  })
})
