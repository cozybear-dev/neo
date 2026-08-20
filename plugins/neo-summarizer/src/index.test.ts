import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHARS_PER_TOKEN,
  PRE_TRUNCATE_TOKENS,
  SUMMARY_MAX_TOKENS,
  SUMMARIZE_THRESHOLD_TOKENS,
  collectStreamText,
  createPostExecuteHandler,
  estimateTokens,
  llmCompleteFromStream,
  processLargeToolOutput,
  truncateToTokens,
  type LlmComplete,
} from './summarize.ts'

function tokensOfXs(n: number): string {
  return 'x'.repeat(n * CHARS_PER_TOKEN)
}

describe('estimateTokens', () => {
  it('uses ceil(chars / 4)', () => {
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens('abcd'), 1)
    assert.equal(estimateTokens('abcde'), 2)
    assert.equal(estimateTokens(tokensOfXs(100)), 100)
    assert.equal(estimateTokens(tokensOfXs(12_000)), 12_000)
  })
})

describe('truncateToTokens', () => {
  it('leaves short text alone', () => {
    assert.equal(truncateToTokens('hello', 10), 'hello')
  })

  it('head/tail truncates oversized text under the budget', () => {
    const big = tokensOfXs(5_000)
    const out = truncateToTokens(big, 100)
    assert.ok(estimateTokens(out) <= 100)
    assert.match(out, /truncated from ~5000 tokens/)
    assert.ok(out.startsWith('xxxx'))
    assert.ok(out.endsWith('xxxx'))
  })
})

describe('processLargeToolOutput', () => {
  it('leaves a 100-token result untouched', async () => {
    const text = tokensOfXs(100)
    const llm: LlmComplete = async () => {
      throw new Error('llm should not be called')
    }
    const out = await processLargeToolOutput({
      text,
      toolName: 'bash',
      llm,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    assert.equal(out.action, 'unchanged')
    assert.equal(out.text, text)
  })

  it('replaces a 12k-token result via fake llm', async () => {
    const text = tokensOfXs(12_000)
    assert.ok(estimateTokens(text) > SUMMARIZE_THRESHOLD_TOKENS)

    let sawUser = ''
    const llm: LlmComplete = async (input) => {
      sawUser = input.user
      assert.equal(input.provider, 'deepseek-official')
      assert.equal(input.model, 'deepseek-v4-flash')
      assert.equal(input.maxTokens, SUMMARY_MAX_TOKENS)
      assert.match(input.user, /Tool: nmap/)
      assert.match(input.user, /Objective: map juice-shop/)
      return 'hosts: 10.0.0.1 open 80,443'
    }

    const out = await processLargeToolOutput({
      text,
      toolName: 'nmap',
      objective: 'map juice-shop',
      llm,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    assert.equal(out.action, 'summarized')
    assert.match(out.text, /Condensed tool result/)
    assert.match(out.text, /hosts: 10\.0\.0\.1 open 80,443/)
    assert.ok(estimateTokens(out.text) < estimateTokens(text))
    assert.ok(sawUser.includes('x'.repeat(100)))
  })

  it('pre-truncates before summarize when over 900k tokens', async () => {
    const text = tokensOfXs(PRE_TRUNCATE_TOKENS + 1_000)
    let userLen = 0
    const llm: LlmComplete = async (input) => {
      // user prompt includes the tool output after headers; bound near pre-truncate
      const marker = 'Tool output:\n'
      const idx = input.user.indexOf(marker)
      assert.ok(idx >= 0)
      const body = input.user.slice(idx + marker.length)
      userLen = body.length
      assert.ok(estimateTokens(body) <= PRE_TRUNCATE_TOKENS)
      return 'ok-summary'
    }
    const out = await processLargeToolOutput({
      text,
      toolName: 'bash',
      llm,
      provider: 'p',
      model: 'm',
    })
    assert.equal(out.action, 'summarized')
    assert.ok(userLen < text.length)
  })

  it('falls back to truncate when llm throws', async () => {
    const text = tokensOfXs(12_000)
    const llm: LlmComplete = async () => {
      throw new Error('provider down')
    }
    const out = await processLargeToolOutput({
      text,
      toolName: 'bash',
      llm,
      provider: 'p',
      model: 'm',
    })
    assert.equal(out.action, 'truncated')
    assert.ok(estimateTokens(out.text) <= SUMMARY_MAX_TOKENS)
    assert.match(out.text, /truncated from/)
  })

  it('truncates only when llm is missing', async () => {
    const text = tokensOfXs(12_000)
    const out = await processLargeToolOutput({
      text,
      toolName: 'bash',
      llm: null,
      provider: 'p',
      model: 'm',
    })
    assert.equal(out.action, 'truncated')
    assert.ok(estimateTokens(out.text) <= SUMMARY_MAX_TOKENS)
  })

  it('truncates only when provider/model missing', async () => {
    const text = tokensOfXs(12_000)
    const llm: LlmComplete = async () => 'should-not-run'
    const out = await processLargeToolOutput({
      text,
      toolName: 'bash',
      llm,
    })
    assert.equal(out.action, 'truncated')
  })
})

describe('collectStreamText', () => {
  it('assembles text-delta chunks and rejects error finish', async () => {
    async function* ok() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello ' }
      yield { type: 'text-delta', index: 0, text: 'world' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    assert.equal(await collectStreamText(ok()), 'hello world')

    async function* bad() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'nope', code: 'X' } } }
    }
    await assert.rejects(() => collectStreamText(bad()), /error/)
  })
})

describe('createPostExecuteHandler', () => {
  it('calls next() and replaces oversized content via fake llm', async () => {
    let nextCalled = false
    const llm = llmCompleteFromStream(async function* () {
      yield { type: 'text-delta', index: 0, text: 'SUM' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const handler = createPostExecuteHandler({
      getLlm: () => llm,
      getDefaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    })
    const big = tokensOfXs(12_000)
    const decision = await handler(
      { name: 'bash' },
      { content: [{ type: 'text', text: big }] },
      async () => {
        nextCalled = true
        return { kind: 'accept' }
      },
    )
    assert.equal(nextCalled, true)
    assert.equal(decision.kind, 'accept')
    assert.match(decision.content?.[0]?.text ?? '', /Condensed tool result/)
    assert.match(decision.content?.[0]?.text ?? '', /SUM/)
  })

  it('passes through a small result after next()', async () => {
    const handler = createPostExecuteHandler({
      getLlm: () => null,
      getDefaultModel: () => ({}),
    })
    const small = tokensOfXs(100)
    const decision = await handler(
      { name: 'bash' },
      { content: [{ type: 'text', text: small }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content, undefined)
  })
})
