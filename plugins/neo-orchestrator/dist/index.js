import { defineTool } from '@deepseek-ai/dsh-tools';
import { createTools } from "./tools.js";
import { listKnownGlobalTools } from "./delegate.js";
import { catalogSectionText, loadPresetsFromDir, resolvePresetsDir, } from "./presets.js";
export const name = 'neo-orchestrator';
export const inject = ['tools'];
export { createTools } from "./tools.js";
export { REQUIRED_PRESET_IDS, SPECIALIST_OUTPUT_SCHEMA, parsePresetYaml, loadPresetsFromDir, resolvePresetsDir, getPreset, catalogPrompt, catalogSectionText, isSpecialistScope, buildModeMachinePrompt, normalizeMode, } from './presets.js';
export { DSH_AGENT_PLANE_TOOLS, executeDelegate, listKnownGlobalTools, resolveChildren, assertParallelGroupSize, parseParallelGroup, filterAllowlist, } from './delegate.js';
function asSubagents(ctx) {
    const raw = ctx.get('subagents');
    if (!raw || typeof raw.start !== 'function')
        return undefined;
    return raw;
}
function knownGlobalTools(ctx, parent) {
    const tools = (ctx.get('tools') ?? ctx.tools);
    return listKnownGlobalTools(tools, parent);
}
export function apply(ctx) {
    const presets = loadPresetsFromDir(resolvePresetsDir());
    const workspaceDir = process.env.NEO_WORKSPACE || '/workspace';
    const promptApi = ctx.get('systemPrompt');
    if (promptApi && typeof promptApi.section === 'function') {
        promptApi.section({
            name: 'neo:orchestrator',
            order: 50,
            text: (context) => catalogSectionText(context, presets, process.env.NEO_MODE || 'thorough'),
        });
    }
    for (const def of createTools({
        presets,
        workspaceDir,
        env: process.env,
        getSubagents: () => asSubagents(ctx),
        getKnownGlobalTools: (parent) => knownGlobalTools(ctx, parent),
    }))
        ctx.tools.register(defineTool(def));
}
