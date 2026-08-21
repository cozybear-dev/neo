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

  it('browser allowlist includes glob and grep (sandbox_exec stays off)', () => {
    const presets = loadPresetsFromDir(resolvePresetsDir())
    const browser = presets.get('browser')
    assert.ok(browser, 'missing browser preset')
    assert.ok(browser.tool_allowlist.includes('glob'))
    assert.ok(browser.tool_allowlist.includes('grep'))
    assert.equal(browser.tool_allowlist.includes('sandbox_exec'), false)
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

  it('filterAllowlist with parentVisible keeps YAML ∩ parentVisible, not plugin-only known', () => {
    const pluginOnly = ['delegate', 'memory_get', 'memory_update', 'sandbox_exec']
    const parentVisible = [
      ...pluginOnly,
      'read', 'write', 'glob', 'grep', 'web_search', 'skill',
    ]
    const allow = filterAllowlist(
      ['memory_get', 'read', 'write', 'glob', 'grep', 'web_search', 'skill', 'bash'],
      pluginOnly,
      parentVisible,
    )
    assert.deepEqual(allow, [
      'memory_get', 'read', 'write', 'glob', 'grep', 'web_search', 'skill',
    ])
    assert.equal(allow.includes('bash'), false)
  })
})
