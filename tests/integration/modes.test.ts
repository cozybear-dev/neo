import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildModeMachinePrompt,
  catalogPrompt,
  loadPresetsFromDir,
  normalizeMode,
  resolvePresetsDir,
} from '../../plugins/neo-orchestrator/src/presets.ts'

const presets = loadPresetsFromDir(resolvePresetsDir())

const CATALOG_AGENTS = [
  'planner',
  'swarm',
  'explore',
  'judge',
  'verifier',
  'sandbox',
  'xss',
  'recon',
] as const

const MODE_PHRASES = [
  'Mode machine',
  'clarify',
  'explore×3',
  '/workspace/plan.md',
  'DSH plan mode',
  'swarm',
  'judge',
  '≤5 verifiers',
  'confirmed',
  '/workspace/report.md',
  'needs retry',
  'max 2',
  '/workspace/verification/iteration-N.md',
  'unverified',
  'Skip clarify',
] as const

describe('Fast vs Thorough mode machine prompt', () => {
  it('normalizeMode defaults to thorough', () => {
    assert.equal(normalizeMode(undefined), 'thorough')
    assert.equal(normalizeMode('FAST'), 'fast')
    assert.equal(normalizeMode('thorough'), 'thorough')
  })

  it('buildModeMachinePrompt(fast) skips thorough gate steps', () => {
    const text = buildModeMachinePrompt('fast')
    assert.match(text, /Active mode: fast/)
    assert.match(text, /Skip clarify/)
    assert.match(text, /unverified/)
    assert.match(text, /\/workspace\/plan\.md/)
    assert.match(text, /iteration-N\.md/)
  })

  it('buildModeMachinePrompt(thorough) includes full loop', () => {
    const text = buildModeMachinePrompt('thorough')
    assert.match(text, /Active mode: thorough/)
    for (const phrase of MODE_PHRASES) {
      assert.ok(text.includes(phrase), `missing phrase: ${phrase}`)
    }
  })

  it('catalogPrompt snapshot includes mode machine and agent catalog', () => {
    const text = catalogPrompt(presets, 'thorough')
    assert.match(text, /Neo orchestrator/)
    assert.match(text, /Agent catalog:/)
    for (const phrase of MODE_PHRASES) {
      assert.ok(text.includes(phrase), `catalog missing phrase: ${phrase}`)
    }
    for (const id of CATALOG_AGENTS) {
      assert.match(text, new RegExp(`- ${id} `), `catalog missing agent ${id}`)
    }
  })
})
