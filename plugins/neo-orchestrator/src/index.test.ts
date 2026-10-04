import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CHILD_ARTIFACT_MKDIR_OPTS,
  DSH_AGENT_PLANE_TOOLS,
  assertParallelGroupSize,
  executeDelegate,
  listKnownGlobalTools,
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
      'bash',
      'sandbox_exec',
      'oast_register',
      'oast_poll',
      'browser_navigate',
      'browser_act',
      'browser_eval',
      'browser_screenshot',
      'browser_network',
    ]
    for (const tool of banned) {
      assert.equal(
        judge.tool_allowlist.includes(tool),
        false,
        `judge allows ${tool}`,
      )
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
      assert.equal(
        p.tool_allowlist.includes('issue_create'),
        false,
        `${id} allows issue_create`,
      )
      assert.equal(
        p.tool_allowlist.includes('oast_register'),
        false,
        `${id} allows oast`,
      )
    }
    assert.equal(
      getPreset(presets, 'planner').tool_allowlist.includes('sandbox_exec'),
      false,
    )
    assert.ok(
      getPreset(presets, 'explore').tool_allowlist.includes('sandbox_exec'),
    )
  })

  it('rejects malformed yaml', () => {
    assert.throws(
      () => parsePresetYaml('id: x\nwhen_to_use: y\n'),
      (err: unknown) => err instanceof PresetError,
    )
  })

  it('specialist outputSchema requires summary and artifacts', () => {
    assert.deepEqual(SPECIALIST_OUTPUT_SCHEMA.required, [
      'summary',
      'artifacts',
    ])
    assert.ok('findings_claimed' in SPECIALIST_OUTPUT_SCHEMA.properties)
    assert.ok('next_agent' in SPECIALIST_OUTPUT_SCHEMA.properties)
    assert.ok('blockers' in SPECIALIST_OUTPUT_SCHEMA.properties)
  })
})

describe('delegate authorization and lifecycle', () => {
  const id = 'ef2b412d-84ac-4cde-8330-bdfd04154c78',
    env = { NEO_TASK_ID: id, NEO_TASK_TOKEN: 'fixture' }
  function parent() {
    return { options: { neoTaskId: id, neoRunId: id, neoRunToken: 'parent' } }
  }
  async function fixture(fn: () => Promise<void>) {
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {}
      assert.equal(init?.headers?.authorization, 'Bearer fixture')
      if (String(url).endsWith('/finish'))
        return {
          status: 200,
          text: async () => JSON.stringify({ id, status: 'completed' }),
        } as any
      if (String(url).endsWith('/runs')) {
        assert.equal(init.headers['x-neo-run-token'], 'parent')
        return {
          status: 200,
          text: async () =>
            JSON.stringify({ id: randomUUID(), run_token: 'child-secret' }),
        } as any
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id,
            mode: 'fast',
            insights: [],
            facts: [],
            todos: [],
            files: [],
          }),
      } as any
    }) as any
    try {
      await fn()
    } finally {
      globalThis.fetch = original
    }
  }
  it('rejects malformed identity, unknown presets and forbidden planner relationship', async () =>
    fixture(async () => {
      await assert.rejects(
        () =>
          executeDelegate(
            { agent_id: 'explore', prompt: 'x' },
            { presets, workspaceDir: workspace(), env: {} },
          ),
        /identity required/,
      )
      await assert.rejects(
        () =>
          executeDelegate(
            { agent_id: 'missing', prompt: 'x' },
            { presets, workspaceDir: workspace(), env },
          ),
        /unknown agent_id/,
      )
      await assert.rejects(
        () =>
          executeDelegate(
            { agent_id: 'recon', prompt: 'x' },
            {
              presets,
              workspaceDir: workspace(),
              env,
              callerAgentId: 'planner',
            },
          ),
        /planner may only/,
      )
    }))
  it('caps per-preset groups and task-wide nested concurrency', async () =>
    fixture(async () => {
      assert.throws(
        () =>
          assertParallelGroupSize(
            presets,
            Array.from({ length: 4 }, () => ({ agent_id: 'explore' })),
          ),
        /max_parallel/,
      )
      await assert.rejects(
        () =>
          executeDelegate(
            { agent_id: 'explore', prompt: 'x', parallel_group: [{}, {}, {}] },
            {
              presets,
              workspaceDir: workspace(),
              env: { ...env, NEO_TASK_CONCURRENCY: '2' },
            },
          ),
        /concurrency limit/,
      )
    }))
  it('registers child provenance, creates private run directory before start and propagates tokens/model', async () =>
    fixture(async () => {
      const dir = workspace()
      let disposed = false
      const result = await executeDelegate(
        { agent_id: 'explore', prompt: 'x' },
        {
          presets,
          workspaceDir: dir,
          env: {
            ...env,
            NEO_RESOLVED_WORKHORSE_PROVIDER: 'p',
            NEO_RESOLVED_WORKHORSE_MODEL: 'm',
          },
          parent: parent(),
          subagents: {
            start: async (_, request) => {
              const options = request.agentOptions as any
              assert.equal(options.neoTaskId, id)
              assert.equal(options.neoRunToken, 'child-secret')
              assert.equal(options.provider, 'p')
              assert.equal(options.model, 'm')
              assert.equal(
                (request.toolFilter as any).allow.includes('bash'),
                false,
              )
              assert.ok(
                statSync(
                  join(dir, 'tasks', id, 'agents', 'explore', options.neoRunId),
                ).isDirectory(),
              )
              return {
                result: Promise.resolve({
                  structured: { summary: 'done', artifacts: [] },
                  stopReason: 'completed',
                }),
                dispose: async () => {
                  disposed = true
                },
              }
            },
          },
        },
      )
      assert.equal(disposed, true)
      assert.equal(result.results[0].summary, 'done')
      assert.equal(CHILD_ARTIFACT_MKDIR_OPTS.mode, 0o770)
      assert.ok(
        result.results[0].artifact_path.includes(
          '/tasks/' + id + '/agents/explore/',
        ),
      )
      assert.equal(statSync(result.results[0].artifact_path).mode & 0o007, 0)
    }))
  it('settles child failures and preserves sibling completion evidence', async () =>
    fixture(async () => {
      let count = 0
      const result = await executeDelegate(
        {
          agent_id: 'explore',
          parallel_group: [{ prompt: 'a' }, { prompt: 'b' }],
        },
        {
          presets,
          workspaceDir: workspace(),
          env,
          parent: parent(),
          subagents: {
            start: async () => {
              const n = count++
              return {
                result:
                  n === 0
                    ? Promise.reject(new Error('fixture failure'))
                    : Promise.resolve({
                        structured: { summary: 'survived', artifacts: [] },
                      }),
                dispose: async () => {},
              }
            },
          },
        },
      )
      assert.equal(result.results.length, 2)
      assert.equal(result.results[1].summary, 'survived')
      assert.match(result.results[0].blockers[0], /fixture failure/)
    }))
  it('records a failed run when its artifact directory cannot be created', async () =>
    fixture(async () => {
      const dir = workspace()
      writeFileSync(join(dir, 'tasks'), 'blocks directory creation')
      const fetchImpl = globalThis.fetch
      const finishes: any[] = []
      globalThis.fetch = (async (url: any, init: any) => {
        if (String(url).endsWith('/finish'))
          finishes.push(JSON.parse(init.body))
        return fetchImpl(url, init)
      }) as any
      await assert.rejects(
        executeDelegate(
          { agent_id: 'explore', prompt: 'x' },
          { presets, workspaceDir: dir, env, parent: parent() },
        ),
        /ENOTDIR/,
      )
      assert.equal(finishes.length, 1)
      assert.equal(finishes[0].status, 'failed')
      assert.match(finishes[0].outcome.error, /ENOTDIR/)
    }))
  it('marks missing spawn capability unexecuted', async () =>
    fixture(async () => {
      const result = await executeDelegate(
        { agent_id: 'explore', prompt: 'x' },
        { presets, workspaceDir: workspace(), env, parent: parent() },
      )
      assert.match(result.results[0].summary, /No model child ran/)
      assert.ok(
        result.results[0].blockers.includes('subagent spawn unavailable'),
      )
    }))
  it('child deadline disposes stalled runtime and records failed outcome', async () =>
    fixture(async () => {
      let disposed = false
      const keepalive = setTimeout(() => {}, 100)
      try {
        const result = await executeDelegate(
          { agent_id: 'explore', prompt: 'stall' },
          {
            presets,
            workspaceDir: workspace(),
            env: { ...env, NEO_CHILD_TIMEOUT_MS: '5' },
            parent: parent(),
            subagents: {
              start: async () => ({
                result: new Promise(() => {}),
                dispose: async () => {
                  disposed = true
                },
              }),
            },
          },
        )
        assert.equal(disposed, true)
        assert.equal(result.ok, false)
        assert.match(result.results[0].blockers[0], /timeout|abort/i)
      } finally {
        clearTimeout(keepalive)
      }
    }))
  it('fails closed for unsupported hardware and Ghidra despite environment strings', () => {
    assert.match(
      failClosedReason(getPreset(presets, 'android'), {
        ANDROID_SERIAL: 'attached',
      })!,
      /unavailable/,
    )
    assert.match(
      failClosedReason(getPreset(presets, 'ios'), {
        IOS_SSH_HOST: 'attached',
      })!,
      /unavailable/,
    )
    assert.match(
      failClosedReason(getPreset(presets, 'ghidra'), {})!,
      /unavailable/,
    )
  })
  it('has persisted plan and verifier tools', () => {
    const names = createTools({ presets, env }).map((t) => t.name)
    assert.ok(names.includes('plan_submit'))
    assert.ok(names.includes('verification_record'))
  })
})

describe('catalog prompt', () => {
  it('lists every preset id and embeds the mode machine', () => {
    const text = catalogPrompt(presets, 'thorough')
    assert.match(text, /Neo orchestrator/)
    assert.match(text, /Mode machine/)
    assert.match(text, /\/workspace\/plan\.md/)
    assert.match(text, /iteration-N\.md/)
    assert.equal(
      buildModeMachinePrompt('thorough').includes('≤5 verifiers'),
      true,
    )
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
    assert.equal(
      /plan mode|exit_plan_mode/i.test(buildModeMachinePrompt('thorough')),
      false,
    )
    assert.match(buildModeMachinePrompt('thorough'), /plan_submit/)
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

describe('listKnownGlobalTools', () => {
  it('keeps global schemas when schemas(parent) throws', () => {
    const schemas = (scope?: unknown) => {
      if (scope != null) throw new Error('parent catalog failed')
      return [{ name: 'scope_check' }, { name: 'memory_get' }]
    }
    const names = listKnownGlobalTools({ schemas }, { id: 'parent' })
    assert.ok(names)
    assert.ok(names.includes('scope_check'))
    assert.ok(names.includes('memory_get'))
    for (const name of DSH_AGENT_PLANE_TOOLS) {
      assert.ok(names.includes(name), `missing agent-plane tool ${name}`)
    }
  })
})
