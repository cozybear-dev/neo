/** Fixed density matching @deepseek-ai/dsh-token-meter (CHARS_PER_TOKEN = 4). */
export const CHARS_PER_TOKEN = 4;
/** Summarize when model-facing tool output exceeds this many heuristic tokens. */
export const SUMMARIZE_THRESHOLD_TOKENS = 10_000;
/** Pre-truncate input to the LLM when over this many heuristic tokens. */
export const PRE_TRUNCATE_TOKENS = 900_000;
/** Cap for the condensed summary returned to the model. */
export const SUMMARY_MAX_TOKENS = 1_500;
/** Heuristic token count (ceil(chars / 4)), same density as DSH token-meter. */
export function estimateTokens(text) {
    if (text.length === 0)
        return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * Head/tail truncate to ~maxTokens. Preserves start and end; inserts a marker.
 */
export function truncateToTokens(text, maxTokens) {
    if (maxTokens <= 0)
        return '';
    if (estimateTokens(text) <= maxTokens)
        return text;
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const originalTokens = estimateTokens(text);
    const marker = `\n\n…[truncated from ~${originalTokens} tokens to ~${maxTokens}]…\n\n`;
    const budget = Math.max(0, maxChars - marker.length);
    const head = Math.ceil(budget / 2);
    const tail = Math.floor(budget / 2);
    return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}
export function flattenPlainText(content) {
    let text = '';
    for (const block of content) {
        if (block.type !== 'text' || typeof block.text !== 'string')
            return undefined;
        text += block.text;
    }
    return text;
}
function buildSummaryPrompt(toolName, objective, output) {
    return {
        system: [
            'You summarize oversized tool outputs for a security-assessment agent.',
            'Preserve concrete facts: hosts, URLs, paths, status codes, errors, IDs, commands, and findings.',
            'Omit noise and repetition. Do not invent details. Output plain text only.',
            `Keep the summary under ~${SUMMARY_MAX_TOKENS} tokens.`,
        ].join(' '),
        user: [
            `Tool: ${toolName}`,
            `Objective: ${objective}`,
            '',
            'Tool output:',
            output,
        ].join('\n'),
    };
}
/**
 * If text is over the summarize threshold, replace with an LLM summary (via `llm`).
 * Missing llm / missing provider+model / LLM failure → truncated original.
 * Under threshold → unchanged.
 */
export async function processLargeToolOutput(input) {
    const tokens = estimateTokens(input.text);
    if (tokens <= SUMMARIZE_THRESHOLD_TOKENS) {
        return { text: input.text, action: 'unchanged' };
    }
    const objective = (input.objective && input.objective.trim()) || 'Continue the current agent task';
    let toSummarize = input.text;
    if (tokens > PRE_TRUNCATE_TOKENS) {
        toSummarize = truncateToTokens(input.text, PRE_TRUNCATE_TOKENS);
    }
    const provider = input.provider?.trim();
    const model = input.model?.trim();
    if (!input.llm || !provider || !model) {
        return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' };
    }
    try {
        if (input.signal?.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
        }
        const prompt = buildSummaryPrompt(input.toolName, objective, toSummarize);
        const summary = await input.llm({
            provider,
            model,
            system: prompt.system,
            user: prompt.user,
            maxTokens: SUMMARY_MAX_TOKENS,
            signal: input.signal,
        });
        const trimmed = summary.trim();
        if (trimmed.length === 0) {
            return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' };
        }
        const capped = estimateTokens(trimmed) > SUMMARY_MAX_TOKENS
            ? truncateToTokens(trimmed, SUMMARY_MAX_TOKENS)
            : trimmed;
        const header = `[neo-summarizer] Condensed tool result for "${input.toolName}" (was ~${tokens} tokens):\n\n`;
        return { text: header + capped, action: 'summarized' };
    }
    catch {
        return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' };
    }
}
/** Collect text from a ctx.llm.stream()-compatible chunk iterable. */
export async function collectStreamText(stream) {
    let text = '';
    let finishKind;
    for await (const chunk of stream) {
        const type = chunk.type;
        if (type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
        }
        else if (type === 'block-end') {
            const block = chunk.block;
            if (block?.type === 'text' && typeof block.text === 'string' && text.length === 0) {
                text = block.text;
            }
        }
        else if (type === 'finish') {
            const reason = chunk.reason;
            finishKind = reason?.kind;
        }
    }
    if (finishKind === 'error' || finishKind === 'aborted') {
        throw new Error(`llm stream finished with ${finishKind}`);
    }
    return text;
}
/** Wrap ctx.llm.stream into the LlmComplete used by processLargeToolOutput. */
export function llmCompleteFromStream(streamFn) {
    return async (input) => {
        const messages = [{
                id: crypto.randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: input.user }],
                source: { kind: 'plugin', plugin: 'neo-summarizer' },
            }];
        const options = {
            provider: input.provider,
            model: input.model,
            system: input.system,
            messages,
            maxTokens: input.maxTokens,
        };
        if (input.signal)
            options.signal = input.signal;
        return collectStreamText(streamFn(options));
    };
}
export function resolveObjective(exec) {
    const header = exec.agent?.session?.header;
    const fromHeader = header?.goal ?? header?.title;
    if (typeof fromHeader === 'string' && fromHeader.trim())
        return fromHeader.trim();
    const fromOpts = exec.agent?.options?.objective;
    if (typeof fromOpts === 'string' && fromOpts.trim())
        return fromOpts.trim();
    return 'Continue the current agent task';
}
/**
 * Cordis `tools/post-execute` waterfall listener. Always awaits `next()`.
 * Oversized plain-text results are summarized (or truncated on failure / missing llm).
 */
export function createPostExecuteHandler(deps) {
    return async (exec, result, next) => {
        const decision = await next();
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value'))
            return decision;
        // Nested Code Mode sub-calls: leave model-facing parent result to the outer arm.
        if (exec.parent !== undefined)
            return decision;
        const content = decision.content ?? result.content;
        const text = flattenPlainText(content);
        if (text === undefined)
            return decision;
        const { provider, model } = deps.getDefaultModel(exec);
        const processed = await processLargeToolOutput({
            text,
            toolName: exec.name,
            objective: (deps.getObjective ?? resolveObjective)(exec),
            llm: deps.getLlm(),
            provider,
            model,
            signal: exec.signal,
        });
        if (processed.action === 'unchanged')
            return decision;
        return { kind: 'accept', content: [{ type: 'text', text: processed.text }] };
    };
}
