import { executeDelegate, } from "./delegate.js";
import { loadPresetsFromDir, resolvePresetsDir, } from "./presets.js";
const callerIds = new WeakMap();
function render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
}
function callerAgentId(exec) {
    const agent = exec.agent;
    if (agent && typeof agent === 'object' && callerIds.has(agent)) {
        return callerIds.get(agent);
    }
    if (agent && typeof agent === 'object') {
        const rec = agent;
        if (typeof rec.options?.neoAgentId === 'string')
            return rec.options.neoAgentId;
        if (typeof rec.label === 'string')
            return rec.label;
    }
    return process.env.NEO_AGENT_ID || 'orchestrator';
}
export function createTools(deps) {
    const options = deps ?? {};
    const presets = options.presets ?? loadPresetsFromDir(resolvePresetsDir());
    const workspaceDir = options.workspaceDir ?? (process.env.NEO_WORKSPACE || '/workspace');
    const env = options.env ?? process.env;
    return [{
            name: 'delegate',
            description: 'Spawn a named Neo specialist preset (persona + toolFilter + outputSchema). '
                + 'Pass parallel_group to start N children and await all (explore×3, verifier×5, swarm streams). '
                + 'Unknown agent_id is rejected. Size is capped by each preset max_parallel. '
                + 'Do not pass a provider or model. When a workhorse model is configured, every child uses it; otherwise children inherit the parent. Prefer this over a generic subagent tool.',
            parameters: {
                agent_id: {
                    type: 'string',
                    required: true,
                    description: 'Preset id (orchestrator, planner, swarm, explore, recon, …).',
                },
                prompt: {
                    type: 'string',
                    required: true,
                    description: 'Complete standalone task for the child. Include scope, mode, and paths.',
                },
                parallel_group: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            agent_id: { type: 'string', description: 'Defaults to the top-level agent_id.' },
                            prompt: { type: 'string', description: 'Defaults to the top-level prompt.' },
                        },
                    },
                    description: 'Start N children in parallel and await all. Size cannot exceed preset max_parallel.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true, const: true },
                        backend: { type: 'string', required: true },
                        results: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: true,
                                properties: {
                                    agent_id: { type: 'string', required: true },
                                    run_id: { type: 'string', required: true },
                                    backend: { type: 'string', required: true },
                                    artifact_path: { type: 'string', required: true },
                                    summary: { type: 'string', required: true },
                                    artifacts: { type: 'array', items: { type: 'string' }, required: true },
                                    findings_claimed: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
                                    next_agent: { type: 'string', required: true },
                                    blockers: { type: 'array', items: { type: 'string' }, required: true },
                                },
                            },
                        },
                    },
                },
                render,
            },
            async execute(args, exec) {
                const subagents = options.getSubagents ? options.getSubagents() : options.subagents;
                // Execute-time snapshot so `delegate` is visible to planner/swarm/judge children.
                const knownGlobalTools = options.getKnownGlobalTools
                    ? options.getKnownGlobalTools(exec.agent)
                    : options.knownGlobalTools;
                // Getter returns parent∪global∪agent-plane; reuse as parentVisible. Else pass option through.
                const parentVisibleTools = options.getKnownGlobalTools
                    ? knownGlobalTools
                    : options.parentVisibleTools;
                return executeDelegate(args, {
                    presets,
                    workspaceDir,
                    env,
                    signal: exec.signal,
                    parent: exec.agent,
                    callerAgentId: callerAgentId(exec),
                    subagents,
                    knownGlobalTools,
                    parentVisibleTools,
                    onSpawnedAgent: (agent, id) => {
                        if (agent && typeof agent === 'object')
                            callerIds.set(agent, id);
                    },
                });
            },
        }];
}
