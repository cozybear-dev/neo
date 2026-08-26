import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECIALIST_OUTPUT_SCHEMA, failClosedReason, getPreset, PresetError, } from "./presets.js";
const DEFAULT_CONCURRENCY = 4;
const JUDGE_ONLY_CHILD = 'verifier';
export function parseParallelGroup(raw) {
    if (raw == null)
        return undefined;
    if (!Array.isArray(raw)) {
        throw new PresetError('parallel_group must be an array of {agent_id?, prompt}');
    }
    return raw.map((item, i) => {
        if (typeof item === 'string')
            return { prompt: item };
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new PresetError(`parallel_group[${i}] must be an object or string`);
        }
        const rec = item;
        return {
            agent_id: typeof rec.agent_id === 'string' ? rec.agent_id : undefined,
            prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
        };
    });
}
export function resolveChildren(args) {
    const topId = typeof args.agent_id === 'string' ? args.agent_id : '';
    const topPrompt = typeof args.prompt === 'string' ? args.prompt : '';
    const group = parseParallelGroup(args.parallel_group);
    if (group) {
        if (group.length === 0)
            throw new PresetError('parallel_group must not be empty');
        return group.map((item, i) => {
            const agent_id = item.agent_id || topId;
            const prompt = item.prompt || topPrompt;
            if (!agent_id)
                throw new PresetError(`parallel_group[${i}] missing agent_id`);
            if (!prompt)
                throw new PresetError(`parallel_group[${i}] missing prompt`);
            return { agent_id, prompt };
        });
    }
    if (!topId)
        throw new PresetError('agent_id is required');
    if (!topPrompt)
        throw new PresetError('prompt is required');
    return [{ agent_id: topId, prompt: topPrompt }];
}
export function assertParallelGroupSize(presets, children) {
    const counts = new Map();
    for (const child of children) {
        getPreset(presets, child.agent_id);
        counts.set(child.agent_id, (counts.get(child.agent_id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
        const preset = getPreset(presets, id);
        if (n > preset.max_parallel) {
            throw new PresetError(`parallel_group size ${n} exceeds max_parallel ${preset.max_parallel} for agent_id ${id}`);
        }
    }
}
export function assertCallerPolicy(callerAgentId, children) {
    if (callerAgentId !== 'judge')
        return;
    const bad = children.filter((c) => c.agent_id !== JUDGE_ONLY_CHILD);
    if (bad.length > 0) {
        throw new PresetError(`judge may only delegate to ${JUDGE_ONLY_CHILD} (got ${bad.map((c) => c.agent_id).join(', ')})`);
    }
}
export function specialistUnavailable(agentId, reason) {
    return {
        summary: reason,
        artifacts: [],
        findings_claimed: [],
        next_agent: '',
        blockers: [reason],
    };
}
export function normalizeSpecialist(value, fallbackSummary = '') {
    const rec = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const summary = typeof rec.summary === 'string' && rec.summary.trim() !== ''
        ? rec.summary
        : fallbackSummary;
    const artifacts = Array.isArray(rec.artifacts)
        ? rec.artifacts.filter((a) => typeof a === 'string')
        : [];
    const findings_claimed = Array.isArray(rec.findings_claimed)
        ? rec.findings_claimed.filter((f) => !!f && typeof f === 'object' && !Array.isArray(f))
        : [];
    const next_agent = typeof rec.next_agent === 'string' ? rec.next_agent : '';
    const blockers = Array.isArray(rec.blockers)
        ? rec.blockers.filter((b) => typeof b === 'string')
        : [];
    if (!summary) {
        return { summary: fallbackSummary || 'child returned no summary', artifacts, findings_claimed, next_agent, blockers };
    }
    return { summary, artifacts, findings_claimed, next_agent, blockers };
}
export async function executeDelegate(args, opts) {
    const children = resolveChildren(args);
    for (const child of children)
        getPreset(opts.presets, child.agent_id);
    assertParallelGroupSize(opts.presets, children);
    assertCallerPolicy(opts.callerAgentId, children);
    throwIfAborted(opts.signal);
    const concurrency = Math.max(1, opts.concurrency ?? intEnv(opts.env?.NEO_DELEGATE_CONCURRENCY, DEFAULT_CONCURRENCY));
    const useSpawn = Boolean(opts.subagents?.start && opts.parent);
    const backend = useSpawn ? 'spawn' : 'in-process';
    const results = await mapPool(children, concurrency, (child, index) => runOne(child, index, opts, backend), opts.signal);
    return { ok: true, backend, results };
}
async function runOne(child, index, opts, backend) {
    throwIfAborted(opts.signal);
    const preset = getPreset(opts.presets, child.agent_id);
    const env = opts.env ?? {};
    const runId = makeRunId(preset.id, index, opts.now);
    const closed = failClosedReason(preset, env);
    const structured = closed
        ? specialistUnavailable(preset.id, closed)
        : backend === 'spawn'
            ? await runSpawn(preset, child.prompt, runId, opts)
            : inProcessRecord(preset, child.prompt);
    return writeChildOutput(preset, runId, backend, structured, opts.workspaceDir);
}
async function runSpawn(preset, prompt, runId, opts) {
    const start = opts.subagents.start;
    const skillsNote = preset.skills.length > 0
        ? `\nActivate at most 3 skills from: ${preset.skills.join(', ')}.`
        : '';
    const memoryNote = await formatTaskMemoryInject(opts);
    const childPrompt = [
        prompt,
        '',
        'Return structured output with summary and artifacts[]. Prefer sandbox_exec over bash for scans.',
        `Write working files under /workspace/agents/${preset.id}/.`,
        skillsNote,
    ].join('\n');
    const injectBlocks = memoryNote
        ? [{ type: 'text', text: memoryNote }]
        : undefined;
    const run = await start('spawn', {
        label: preset.id,
        prompt: [{ type: 'text', text: childPrompt }],
        parent: opts.parent,
        signal: opts.signal,
        persona: preset.persona,
        toolFilter: { allow: preset.tool_allowlist },
        outputSchema: SPECIALIST_OUTPUT_SCHEMA,
        agentOptions: { neoAgentId: preset.id },
        ...(injectBlocks ? { inject: injectBlocks } : {}),
    });
    try {
        if (run.localAgent && opts.onSpawnedAgent)
            opts.onSpawnedAgent(run.localAgent, preset.id);
        await injectIntoAgent(run.localAgent, injectBlocks);
        const result = await run.result;
        const text = Array.isArray(result.output)
            ? result.output.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
            : '';
        if (result.stopReason && result.stopReason !== 'completed') {
            return specialistUnavailable(preset.id, result.diagnostic || `subagent ${preset.id} ended (${result.stopReason})`);
        }
        return normalizeSpecialist(result.structured, text || `${preset.id} completed`);
    }
    finally {
        await run.dispose();
    }
}
async function formatTaskMemoryInject(opts) {
    const env = opts.env ?? process.env;
    const taskId = env.NEO_TASK_ID?.trim();
    if (!taskId)
        return undefined;
    const control = (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '');
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== 'function')
        return undefined;
    try {
        const res = await fetchImpl(`${control}/tasks/${encodeURIComponent(taskId)}/memory`, {
            signal: opts.signal,
        });
        const raw = await res.text();
        if (!res.ok || !raw)
            return undefined;
        const body = JSON.parse(raw);
        return [
            'Shared task memory (injected on subagent/start):',
            JSON.stringify({
                insights: Array.isArray(body.insights) ? body.insights : [],
                facts: Array.isArray(body.facts) ? body.facts : [],
                todos: Array.isArray(body.todos) ? body.todos : [],
                files: Array.isArray(body.files) ? body.files : [],
            }),
        ].join('\n');
    }
    catch {
        return undefined;
    }
}
async function injectIntoAgent(localAgent, blocks) {
    if (!blocks?.length || !localAgent || typeof localAgent !== 'object')
        return;
    const agent = localAgent;
    if (typeof agent.inject !== 'function')
        return;
    try {
        await Promise.resolve(agent.inject(blocks));
    }
    catch {
        // best-effort; child still runs with start-request inject when supported
    }
}
function inProcessRecord(preset, prompt) {
    return {
        summary: `${preset.id} recorded by the in-process runner (ctx.subagents.start missing). `
            + 'No model child ran; this is not a second agent loop.',
        artifacts: [],
        findings_claimed: [],
        next_agent: '',
        blockers: [
            'subagent spawn unavailable',
            `persona applied in record only (${preset.id})`,
        ],
        // prompt retained on disk via writeChildOutput meta, not in model-facing blockers
    };
}
function writeChildOutput(preset, runId, backend, structured, workspaceDir) {
    const dir = join(workspaceDir, 'agents', preset.id);
    mkdirSync(dir, { recursive: true });
    const artifactPath = join(dir, `${runId}.json`).replace(/\\/g, '/');
    const artifacts = structured.artifacts.includes(artifactPath)
        ? structured.artifacts
        : [...structured.artifacts, artifactPath];
    const result = {
        agent_id: preset.id,
        run_id: runId,
        backend,
        artifact_path: artifactPath,
        summary: structured.summary,
        artifacts,
        findings_claimed: structured.findings_claimed,
        next_agent: structured.next_agent,
        blockers: structured.blockers,
    };
    writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
}
function makeRunId(agentId, index, now) {
    const d = (now ? now() : new Date()).toISOString().replace(/[:.]/g, '-');
    return `${d}-${agentId}-${index}`;
}
function intEnv(raw, fallback) {
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
}
async function mapPool(items, limit, fn, signal) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            throwIfAborted(signal);
            const i = next;
            next += 1;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i], i);
        }
    }
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return out;
}
