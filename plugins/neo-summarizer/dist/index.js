import { createPostExecuteHandler, llmCompleteFromStream, } from './summarize.js';
export const name = 'neo-summarizer';
export const inject = ['tools'];
export { CHARS_PER_TOKEN, SUMMARY_MAX_TOKENS, SUMMARIZE_THRESHOLD_TOKENS, PRE_TRUNCATE_TOKENS, estimateTokens, truncateToTokens, flattenPlainText, processLargeToolOutput, collectStreamText, llmCompleteFromStream, createPostExecuteHandler, resolveObjective, } from './summarize.js';
function resolveDefaultModel(ctx, exec) {
    const fromService = ctx.get('agentDefaultModel');
    const selection = fromService?.currentSelection?.();
    if (selection?.provider && selection?.model) {
        return { provider: selection.provider, model: selection.model };
    }
    const opts = exec.agent?.options;
    if (opts?.provider && opts?.model) {
        return { provider: opts.provider, model: opts.model };
    }
    return {};
}
function resolveLlm(ctx) {
    const llm = (ctx.get('llm') ?? ctx.llm);
    if (!llm || typeof llm.stream !== 'function')
        return null;
    return llmCompleteFromStream(llm.stream.bind(llm));
}
export function apply(ctx) {
    ctx.on('tools/post-execute', createPostExecuteHandler({
        getLlm: () => resolveLlm(ctx),
        getDefaultModel: (exec) => resolveDefaultModel(ctx, exec),
    }));
}
