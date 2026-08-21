import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CHILD_ARTIFACT_MKDIR_OPTS,
  assertParallelGroupSize,
  executeDelegate,
  resolveChildren,
} from './delegate.ts'
import {
  REQUIRED_PRESET_IDS,
  SPECIALIST_OUTPUT_SCHEMA,
  buildModeMachinePrompt,
  catalogPrompt,
  catalogSectionText,
  failClosedReason,
  getPreset,
  loadPresetsFromDir,
  parsePresetYaml,
  PresetError,
  resolvePresetsDir,
  type AgentPreset,
} from './presets.ts'
import { createTools } from './tools.ts'

const presets = loadPresetsFromDir(resolvePresetsDir())

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'neo-orch-'))
}

describe('preset yaml', () => {
  it('parses every required preset', () => {
    for (const id of REQUIRED_PRESET_IDS) {
      assert.ok(presets.has(id), `missing preset ${id}`)
      const p = presets.get(id) as AgentPreset
      assert.equal(p.id, id)
      assert.ok(p.when_to_use.length > 0)
      assert.ok(p.persona.length > 0)
      assert.ok(Array.isArray(p.tool_allowlist))
      assert.ok(Array.isArray(p.skills))
      assert.ok(p.max_parallel >= 1)
      assert.equal(typeof p.readonly, 'boolean')
    }
    assert.equal(REQUIRED_PRESET_IDS.length, 21)
  })

  it('judge has no bash, browser, or oast tools', () => {
    const judge = getPreset(presets, 'judge')
    const banned = [
      'bash', 'sandbox_exec', 'oast_register', 'oast_poll',
      'browser_navigate', 'browser_act', 'browser_eval', 'browser_screenshot', 'browser_network',
    ]
    for (const tool of banned) {
      assert.equal(judge.tool_allowlist.includes(tool), false, `judge allows ${tool}`)
    }
    assert.ok(judge.tool_allowlist.includes('memory_get'))
    assert.ok(judge.tool_allowlist.includes('issue_query'))
    assert.ok(judge.tool_allowlist.includes('read'))
    assert.ok(judge.tool_allowlist.includes('delegate'))
    assert.equal(judge.readonly, true)
  })

  it('planner and explore cannot issue_create or exploit', () => {
    for (const id of ['planner', 'explore'] as const) {
      const p = getPreset(presets, id)
      assert.equal(p.readonly, true)
      assert.equal(p.tool_allowlist.includes('issue_create'), false, `${id} allows issue_create`)
      assert.equal(p.tool_allowlist.includes('oast_register'), false, `${id} allows oast`)
    }
    assert.equal(getPreset(presets, 'planner').tool_allowlist.includes('sandbox_exec'), false)
    assert.ok(getPreset(presets, 'explore').tool_allowlist.includes('sandbox_exec'))
  })

  it('rejects malformed yaml', () => {
    assert.throws(
      () => parsePresetYaml('id: x\nwhen_to_use: y\n'),
      (err: unknown) => err instanceof PresetError,
    )
  })

  it('specialist outputSchema requires summary and artifacts', () => {
    assert.deepEqual(SPECIALIST_OUTPUT_SCHEMA.required, ['summary', 'artifacts'])
    assert.ok('findings_claimed' in SPECIALIST_OUTPUT_SCHEMA.properties)
    assert.ok('next_agent' in SPECIALIST_OUTPUT_SCHEMA.properties)
    assert.ok('blockers' in SPECIALIST_OUTPUT_SCHEMA.properties)
  })
})

describe('delegate', () => {
  it('rejects unknown agent_id', async () => {
    await assert.rejects(
      () => executeDelegate(
        { agent_id: 'not-a-real-agent', prompt: 'do work' },
        { presets, workspaceDir: workspace() },
      ),
      (err: unknown) => {
        assert.ok(err instanceof PresetError)
        assert.match(err.message, /unknown agent_id: not-a-real-agent/)
        return true
      },
    )
  })

  it('rejects parallel_group larger than max_parallel', () => {
    const explore = getPreset(presets, 'explore')
    assert.equal(explore.max_parallel, 3)
    const four = [
      { agent_id: 'explore', prompt: 'a' },
      { agent_id: 'explore', prompt: 'b' },
      { agent_id: 'explore', prompt: 'c' },
      { agent_id: 'explore', prompt: 'd' },
    ]
    assert.throws(
      () => assertParallelGroupSize(presets, four),
      (err: unknown) => {
        assert.ok(err instanceof PresetError)
        assert.match(err.message, /parallel_group size 4 exceeds max_parallel 3 for agent_id explore/)
        return true
      },
    )
    assert.equal(getPreset(presets, 'verifier').max_parallel, 5)
    const six = Array.from({ length: 6 }, (_, i) => ({ agent_id: 'verifier', prompt: `v${i}` }))
    assert.throws(() => assertParallelGroupSize(presets, six), /max_parallel 5/)
  })

  it('accepts explore x3 and mixed specialists within caps', async () => {
    const dir = workspace()
    const result = await executeDelegate(
      {
        agent_id: 'explore',
        prompt: 'default',
        parallel_group: [
          { prompt: 'surface one' },
          { prompt: 'surface two' },
          { prompt: 'surface three' },
        ],
      },
      { presets, workspaceDir: dir, env: {} },
    )
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'in-process')
    assert.equal(result.results.length, 3)
    for (const child of result.results) {
      assert.equal(child.agent_id, 'explore')
      assert.ok(child.artifact_path.includes('/agents/explore/') || child.artifact_path.includes('\\agents\\explore\\'))
      const onDisk = JSON.parse(readFileSync(child.artifact_path, 'utf8')) as { summary: string }
      assert.equal(onDisk.summary, child.summary)
      assert.match(child.summary, /in-process runner/)
    }
    const files = readdirSync(join(dir, 'agents', 'explore'))
    assert.equal(files.length, 3)
  })

  it('creates child artifact dirs world-writable', async () => {
    const dir = workspace()
    await executeDelegate({ agent_id: 'explore', prompt: 'x' }, { presets, workspaceDir: dir })
    const artifactDir = join(dir, 'agents', 'explore')
    const st = statSync(artifactDir)
    assert.ok(st.isDirectory())
    // mkdirSync mode is umask-masked; production must chmodSync(dir, 0o777) after create.
    assert.equal(CHILD_ARTIFACT_MKDIR_OPTS.mode, 0o777)
    const delegateSrc = readFileSync(new URL('./delegate.ts', import.meta.url), 'utf8')
    assert.match(delegateSrc, /chmodSync\(\s*dir,\s*0o777\s*\)/)
    // NTFS does not surface POSIX other-write bits from chmod.
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o002, 0o002)
    }
  })

  it('fail-closes android/ios without hardware env', async () => {
    assert.match(failClosedReason(getPreset(presets, 'android'), {}) ?? '', /ANDROID_SERIAL/)
    assert.match(failClosedReason(getPreset(presets, 'ios'), {}) ?? '', /IOS_SSH_HOST/)
    assert.equal(failClosedReason(getPreset(presets, 'android'), { ANDROID_SERIAL: 'emulator-5554' }), undefined)

    const dir = workspace()
    const result = await executeDelegate(
      { agent_id: 'android', prompt: 'scan the device' },
      { presets, workspaceDir: dir, env: {} },
    )
    assert.match(result.results[0]!.summary, /ANDROID_SERIAL/)
    assert.ok(result.results[0]!.blockers.length > 0)
  })

  it('uses spawn when ctx.subagents.start exists', async () => {
    const dir = workspace()
    const parent = { id: 'orchestrator-session' }
    let seen: Record<string, unknown> | undefined
    const result = await executeDelegate(
      { agent_id: 'research', prompt: 'map the stack' },
      {
        presets,
        workspaceDir: dir,
        parent,
        subagents: {
          async start(name, request) {
            seen = { name, ...request }
            return {
              id: 'child-1',
              localAgent: { id: 'child-1' },
              result: Promise.resolve({
                stopReason: 'completed',
                structured: {
                  summary: 'notes written',
                  artifacts: ['/workspace/research/notes.md'],
                  findings_claimed: [],
                  next_agent: 'cve',
                  blockers: [],
                },
              }),
              async dispose() {},
            }
          },
        },
      },
    )
    assert.equal(result.backend, 'spawn')
    assert.equal(seen?.name, 'spawn')
    assert.equal(seen?.persona, getPreset(presets, 'research').persona)
    assert.deepEqual(seen?.toolFilter, { allow: getPreset(presets, 'research').tool_allowlist })
    assert.equal(seen?.outputSchema, SPECIALIST_OUTPUT_SCHEMA)
    assert.equal(seen?.parent, parent)
    const opts = seen?.agentOptions as { neoAgentId?: string; provider?: string; model?: string }
    assert.equal(opts.neoAgentId, 'research')
    assert.equal(opts.provider, undefined)
    assert.equal(opts.model, undefined)
    assert.equal(result.results[0]!.summary, 'notes written')
    assert.equal(result.results[0]!.next_agent, 'cve')
  })

  it('keeps this on ctx.subagents.start (DSH SubagentRuntime.expectProvider)', async () => {
    class FakeSubagentRuntime {
      expectProvider(name: string) {
        if (name !== 'spawn') throw new Error(`no subagent provider registered for "${name}"`)
        return { name }
      }

      async start(name: string, request: Record<string, unknown>) {
        this.expectProvider(name)
        return {
          id: 'child-1',
          localAgent: { id: 'child-1' },
          result: Promise.resolve({
            stopReason: 'completed',
            structured: {
              summary: `planner saw: ${String(request.label ?? '')}`,
              artifacts: [],
              findings_claimed: [],
              next_agent: '',
              blockers: [],
            },
          }),
          async dispose() {},
        }
      }
    }

    const result = await executeDelegate(
      { agent_id: 'planner', prompt: 'write /workspace/plan.md' },
      {
        presets,
        workspaceDir: workspace(),
        parent: { id: 'orchestrator-session' },
        subagents: new FakeSubagentRuntime(),
      },
    )
    assert.equal(result.backend, 'spawn')
    assert.equal(result.results[0]!.summary, 'planner saw: planner')
  })

  it('drops unknown global tools from toolFilter so restrict() can apply', async () => {
    // Omit skill (still in planner YAML) to prove live-catalog filtering.
    const known = new Set([
      'delegate',
      'glob',
      'grep',
      'memory_get',
      'memory_update',
      'read',
      'web_search',
      'write',
    ])
    const planner = getPreset(presets, 'planner')
    assert.ok(planner.tool_allowlist.includes('skill'))
    assert.ok(planner.tool_allowlist.includes('web_search'))
    assert.equal(planner.tool_allowlist.includes('web_fetch'), false)

    let seen: Record<string, unknown> | undefined
    const result = await executeDelegate(
      { agent_id: 'planner', prompt: 'write /workspace/plan.md' },
      {
        presets,
        workspaceDir: workspace(),
        parent: { id: 'orchestrator-session' },
        knownGlobalTools: known,
        subagents: {
          async start(_name, request) {
            seen = request
            const allow = (request.toolFilter as { allow: string[] }).allow
            for (const name of allow) {
              if (!known.has(name)) {
                throw new Error(
                  `tools.restrict() names unknown global tool "${name}"; known global tools: ${[...known].sort().join(', ')}`,
                )
              }
            }
            return {
              id: 'child-1',
              localAgent: { id: 'child-1' },
              result: Promise.resolve({
                stopReason: 'completed',
                structured: {
                  summary: 'plan written',
                  artifacts: ['/workspace/plan.md'],
                  findings_claimed: [],
                  next_agent: '',
                  blockers: [],
                },
              }),
              async dispose() {},
            }
          },
        },
      },
    )

    const allow = (seen?.toolFilter as { allow: string[] }).allow
    assert.equal(allow.includes('skill'), false)
    assert.ok(allow.includes('web_search'))
    assert.ok(allow.includes('write'))
    assert.equal(result.results[0]!.summary, 'plan written')
  })

  it('keeps DSH agent-plane builtins when host schemas() is plugin-only', async () => {
    const pluginOnly = [
      'delegate', 'scope_check', 'memory_get', 'memory_update',
      'sandbox_exec', 'issue_query', 'issue_create',
    ]
    let seen: Record<string, unknown> | undefined
    await executeDelegate(
      { agent_id: 'research', prompt: 'map the stack' },
      {
        presets,
        workspaceDir: workspace(),
        parent: { id: 'orchestrator-session' },
        knownGlobalTools: pluginOnly,
        // NEW: parent-visible catalog, as tools.schemas(parent) would return
        parentVisibleTools: [...pluginOnly, 'read', 'write', 'glob', 'grep', 'web_search', 'skill'],
        subagents: {
          async start(_name, request) {
            seen = request
            return {
              id: 'child-1',
              localAgent: {},
              result: Promise.resolve({
                stopReason: 'completed',
                structured: { summary: 'ok', artifacts: [] },
              }),
              async dispose() {},
            }
          },
        },
      },
    )
    const allow = (seen?.toolFilter as { allow: string[] }).allow
    for (const name of ['read', 'write', 'glob', 'grep', 'web_search', 'skill']) {
      assert.ok(allow.includes(name), `research lost ${name}`)
    }
    assert.equal(allow.includes('web_fetch'), false)
    assert.equal(allow.includes('bash'), false)
  })

  it('resolves knownGlobalTools at execute time so planner children keep delegate', async () => {
    const names = [
      'memory_get',
      'memory_update',
      'read',
      'glob',
      'grep',
      'write',
      'web_search',
      'skill',
    ]
    const toolsApi = {
      schemas: () => names.map((name) => ({ name })),
    }
    assert.equal(toolsApi.schemas().some((schema) => schema.name === 'delegate'), false)

    let seen: Record<string, unknown> | undefined
    const subagents = {
      async start(_name: string, request: Record<string, unknown>) {
        seen = request
        return {
          id: 'child-1',
          localAgent: { id: 'child-1' },
          result: Promise.resolve({
            stopReason: 'completed',
            structured: {
              summary: 'plan written',
              artifacts: ['/workspace/plan.md'],
              findings_claimed: [],
              next_agent: '',
              blockers: [],
            },
          }),
          async dispose() {},
        }
      },
    }

    const snapshotAtCreate = toolsApi.schemas()
      .map((schema) => schema.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    const [delegate] = createTools({
      presets,
      workspaceDir: workspace(),
      env: {},
      subagents,
      knownGlobalTools: snapshotAtCreate,
      getSubagents: () => subagents,
      getKnownGlobalTools: () => toolsApi.schemas()
        .map((schema) => schema.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    })

    names.push('delegate')

    await delegate.execute(
      { agent_id: 'planner', prompt: 'write /workspace/plan.md' },
      { signal: new AbortController().signal, agent: { id: 'orchestrator-session' } },
    )

    const allow = (seen?.toolFilter as { allow: string[] } | undefined)?.allow
    assert.ok(allow, 'expected spawn toolFilter')
    assert.ok(
      allow.includes('delegate'),
      `planner toolFilter.allow missing delegate: ${allow.join(', ')}`,
    )
  })

  it('judge may only delegate to verifier', async () => {
    await assert.rejects(
      () => executeDelegate(
        { agent_id: 'sandbox', prompt: 'exploit' },
        { presets, workspaceDir: workspace(), callerAgentId: 'judge' },
      ),
      /judge may only delegate to verifier/,
    )
    const ok = await executeDelegate(
      {
        agent_id: 'verifier',
        prompt: 'retest finding 1',
        parallel_group: [
          { prompt: 'claim a' },
          { prompt: 'claim b' },
        ],
      },
      { presets, workspaceDir: workspace(), callerAgentId: 'judge' },
    )
    assert.equal(ok.results.length, 2)
  })

  it('resolveChildren fills agent_id from the parent call', () => {
    const kids = resolveChildren({
      agent_id: 'verifier',
      prompt: 'fallback',
      parallel_group: [{ prompt: 'one' }, { agent_id: 'verifier', prompt: 'two' }],
    })
    assert.deepEqual(kids, [
      { agent_id: 'verifier', prompt: 'one' },
      { agent_id: 'verifier', prompt: 'two' },
    ])
  })
})

describe('catalog prompt', () => {
  it('lists every preset id and embeds the mode machine', () => {
    const text = catalogPrompt(presets, 'thorough')
    assert.match(text, /Neo orchestrator/)
    assert.match(text, /Mode machine/)
    assert.match(text, /\/workspace\/plan\.md/)
    assert.match(text, /iteration-N\.md/)
    assert.equal(buildModeMachinePrompt('thorough').includes('≤5 verifiers'), true)
    for (const id of REQUIRED_PRESET_IDS) {
      assert.match(text, new RegExp(`- ${id} `))
    }
  })

  it('catalogPrompt is empty for specialist scopes', () => {
    const text = catalogSectionText({
      scope: { options: { neoAgentId: 'research' }, label: 'research' },
    })
    assert.equal(text, '')
  })

  it('catalogPrompt still renders for the root agent', () => {
    const text = catalogSectionText({ scope: { id: 'session-…' } })
    assert.match(text, /You are the Neo orchestrator/)
  })

  it('thorough mode machine does not mention exit_plan_mode or plan mode', () => {
    assert.equal(/plan mode|exit_plan_mode/i.test(buildModeMachinePrompt('thorough')), false)
    assert.match(buildModeMachinePrompt('thorough'), /ask_user_question/)
  })
})

it('does not read ctx.systemPrompt (requires inject)', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /ctx\.systemPrompt\b/)
  assert.match(src, /ctx\.get\(\s*['"]systemPrompt['"]\s*\)/)
})

it('does not read ctx.subagents (requires inject)', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /ctx\.subagents\b/)
  assert.match(src, /ctx\.get\(\s*['"]subagents['"]\s*\)/)
})
