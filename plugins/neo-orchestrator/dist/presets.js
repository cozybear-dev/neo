import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from "./yaml.js";
export const REQUIRED_PRESET_IDS = [
    'orchestrator',
    'planner',
    'swarm',
    'explore',
    'recon',
    'research',
    'cve',
    'pd-oss',
    'sandbox',
    'browser',
    'api',
    'xss',
    'redteam',
    'ghidra',
    'deploy',
    'triage',
    'github-review',
    'judge',
    'verifier',
    'android',
    'ios',
];
export const SPECIALIST_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        findings_claimed: { type: 'array', items: { type: 'object', additionalProperties: true } },
        next_agent: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'artifacts'],
};
export class PresetError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PresetError';
    }
}
export function resolvePresetsDir(env = process.env, cwd = process.cwd()) {
    if (env.NEO_PRESETS_DIR && env.NEO_PRESETS_DIR.trim() !== '')
        return env.NEO_PRESETS_DIR;
    const here = dirname(fileURLToPath(import.meta.url));
    return [
        join(here, '../../../presets'),
        join(cwd, 'presets'),
        '/opt/neo/presets',
    ].find((dir) => {
        try {
            return readdirSync(dir).some((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
        }
        catch {
            return false;
        }
    }) ?? join(cwd, 'presets');
}
export function loadPresetsFromDir(dir) {
    const names = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
    const presets = new Map();
    for (const name of names) {
        const raw = readFileSync(join(dir, name), 'utf8');
        const preset = parsePresetYaml(raw, name.replace(/\.ya?ml$/, ''));
        if (presets.has(preset.id)) {
            throw new PresetError(`duplicate preset id ${preset.id}`);
        }
        presets.set(preset.id, preset);
    }
    return presets;
}
export function parsePresetYaml(source, filenameId) {
    const value = parseYaml(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PresetError('preset yaml must be a mapping');
    }
    const rec = value;
    const id = requiredString(rec, 'id');
    if (filenameId && filenameId !== id) {
        throw new PresetError(`preset id ${id} does not match filename ${filenameId}`);
    }
    const tool_allowlist = requiredStringArray(rec, 'tool_allowlist');
    const skills = optionalStringArray(rec, 'skills');
    const max_parallel = requiredPositiveInt(rec, 'max_parallel');
    const readonly = requiredBoolean(rec, 'readonly');
    return {
        id,
        when_to_use: requiredString(rec, 'when_to_use'),
        persona: requiredString(rec, 'persona'),
        tool_allowlist,
        skills,
        max_parallel,
        readonly,
    };
}
export function getPreset(presets, agentId) {
    const preset = presets.get(agentId);
    if (!preset) {
        const known = [...presets.keys()].sort().join(', ');
        throw new PresetError(`unknown agent_id: ${agentId}${known ? ` (known: ${known})` : ''}`);
    }
    return preset;
}
export function failClosedReason(preset, env) {
    if (preset.id === 'android' && !env.ANDROID_SERIAL) {
        return 'Android hardware not attached. Set ANDROID_SERIAL to enable this agent; swarm continues without it.';
    }
    if (preset.id === 'ios' && !env.IOS_SSH_HOST) {
        return 'iOS lab not attached. Set IOS_SSH_HOST to enable this agent; swarm continues without it.';
    }
    return undefined;
}
function requiredString(rec, key) {
    const v = rec[key];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new PresetError(`preset missing string field ${key}`);
    }
    return v;
}
function requiredBoolean(rec, key) {
    const v = rec[key];
    if (typeof v !== 'boolean')
        throw new PresetError(`preset missing boolean field ${key}`);
    return v;
}
function requiredPositiveInt(rec, key) {
    const v = rec[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        throw new PresetError(`preset ${key} must be a positive integer`);
    }
    return v;
}
function requiredStringArray(rec, key) {
    const v = rec[key];
    if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
        throw new PresetError(`preset ${key} must be a string array`);
    }
    return v;
}
function optionalStringArray(rec, key) {
    const v = rec[key];
    if (v == null)
        return [];
    if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
        throw new PresetError(`preset ${key} must be a string array`);
    }
    return v;
}
export function assertJudgeAllowlist(preset) {
    if (preset.id !== 'judge')
        return;
    const banned = ['bash', 'sandbox_exec', 'oast_register', 'oast_poll',
        'browser_navigate', 'browser_act', 'browser_eval', 'browser_screenshot', 'browser_network'];
    const hit = preset.tool_allowlist.filter((t) => banned.includes(t));
    if (hit.length > 0) {
        throw new PresetError(`judge must not allow ${hit.join(', ')}`);
    }
}
export function normalizeMode(mode) {
    return String(mode ?? '').trim().toLowerCase() === 'fast' ? 'fast' : 'thorough';
}
/** Mode machine as prompt + delegate policy (not a second orchestration loop). */
export function buildModeMachinePrompt(mode = 'thorough') {
    const active = normalizeMode(mode);
    const header = [
        'Mode machine (prompt + delegate policy; not a second orchestration loop).',
        `Active mode: ${active}.`,
        'Always confirm allowlist + authorization; call scope_check before delegate.',
        'Pass mode, allowlist, denylist, secrets-by-reference, and /workspace paths to every child.',
        'Task memory is injected into every child on subagent/start (agent.inject).',
    ];
    const fast = [
        'Fast mode steps:',
        '1. Skip clarify, planner, explore×3, /workspace/plan.md approval, swarm, judge, verifiers, and verification retries.',
        '2. Delegate exactly one specialist (usually sandbox, recon, or pd-oss), then respond.',
        '3. Issues may be filed as unverified.',
    ];
    const thorough = [
        'Thorough mode steps:',
        '1. Clarify scope with the user until targets and constraints are concrete.',
        '2. Delegate planner; planner spawns explore×3 via parallel_group (optional browser for visual recon).',
        '3. Planner writes /workspace/plan.md; use DSH plan mode for the approval gate before execution.',
        '4. After approval, delegate swarm to decompose and run specialist workstreams.',
        '5. Delegate judge; judge may only spawn ≤5 verifiers (parallel_group capped by max_parallel).',
        '6. issue_create only for confirmed findings (never unverified in Thorough).',
        '7. Write /workspace/report.md.',
        '8. If judge returns needs retry: max 2 re-executions; write /workspace/verification/iteration-N.md each time.',
    ];
    if (active === 'fast') {
        return [...header, ...fast, 'Thorough reference (skipped in Fast):', ...thorough.slice(1)].join('\n');
    }
    return [...header, ...thorough, 'Fast reference (not active):', ...fast.slice(1)].join('\n');
}
export function catalogPrompt(presets, mode = process.env.NEO_MODE || 'thorough') {
    const rows = [...presets.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => `- ${p.id} (max_parallel=${p.max_parallel}${p.readonly ? ', readonly' : ''}): ${p.when_to_use}`)
        .join('\n');
    return [
        'You are the Neo orchestrator. Never pentest yourself. Always pass the authorized allowlist to children.',
        'Route by objective using the delegate tool. Prefer sandbox_exec over bash for scans.',
        buildModeMachinePrompt(mode),
        'After specialists, decide verify vs respond. Do not file issues until a verifier confirms in Thorough.',
        'Android/iOS fail closed without ANDROID_SERIAL / IOS_SSH_HOST; continue the swarm.',
        'Judge may only delegate to verifier. Planner/Explore must not issue_create or exploit.',
        'Skills: activate at most 3 SKILL.md files. Workflows live under /opt/neo/workflows/.',
        'Agent catalog:',
        rows,
    ].join('\n');
}
