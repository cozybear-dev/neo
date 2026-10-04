import { createServer } from 'node:http'

/**
 * Anthropic Messages SSE stub. Event order matches tool_call_success and
 * success in the pinned dsh-llm-mock-server (message_start, content blocks,
 * message_delta, message_stop). One server, because that package's sequence
 * uses a single tool name for every request.
 */
export function startMockMessages() {
  const requests = []
  const branches = {
    structured_output: 0,
    child_settled: 0,
    delegate: 0,
    parent_ok: 0,
    parent_failure: 0,
    shell_guard: 0,
    file_guard: 0,
  }
  let servedStructuredOutput = false

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (req.method !== 'POST' || !path.split('?')[0].endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'not found',
            type: 'mock_error',
            code: 'not_found',
          },
        }),
      )
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'invalid json',
            type: 'mock_error',
            code: 'invalid_request',
          },
        }),
      )
      return
    }
    requests.push(body)
    // A correct parent → child → settle → parent reply is 3 or 4 requests.
    // Task memory is injected as next-step input after the child starts, and
    // a concluding structured_output does not drop that queued message, so
    // the child may take one more step. Past this cap the script is looping.
    if (requests.length > 12) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'too many requests',
            type: 'mock_error',
            code: 'loop',
          },
        }),
      )
      return
    }
    const names = toolNames(body)
    const serialized = JSON.stringify(body)
    openSse(res)
    messageStart(res)
    // The follow-up still lists structured_output and still contains
    // HARNESS_CHILD_OK from the prior tool call, so this check is first.
    if (serialized.includes('Structured output recorded')) {
      branches.child_settled += 1
      textReply(res, 'child settled')
      return
    }
    if (names.has('structured_output')) {
      branches.structured_output += 1
      servedStructuredOutput = true
      toolCall(
        res,
        'mock-call-child',
        'structured_output',
        JSON.stringify({
          summary: 'HARNESS_CHILD_OK',
          artifacts: [],
        }),
      )
      return
    }
    if (names.has('delegate') && branches.shell_guard === 0) {
      branches.shell_guard += 1
      toolCall(
        res,
        'mock-shell-guard',
        'bash',
        JSON.stringify({ command: 'echo GUARD_MUST_BLOCK_THIS' }),
      )
      return
    }
    if (names.has('delegate') && branches.file_guard === 0) {
      branches.file_guard += 1
      toolCall(
        res,
        'mock-file-guard',
        'read',
        JSON.stringify({ file_path: '/etc/passwd' }),
      )
      return
    }
    if (names.has('delegate') && branches.delegate === 0) {
      branches.delegate += 1
      toolCall(
        res,
        'mock-call-parent',
        'delegate',
        JSON.stringify({
          agent_id: 'explore',
          prompt: 'Return structured output only.',
        }),
      )
      return
    }
    if (serialized.includes('HARNESS_CHILD_OK')) {
      branches.parent_ok += 1
      textReply(res, 'parent received HARNESS_CHILD_OK')
      return
    }
    branches.parent_failure += 1
    textReply(res, 'parent received failure')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        branches,
        get servedStructuredOutput() {
          return servedStructuredOutput
        },
        close() {
          return new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}

function toolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return new Set(
    tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'),
  )
}

function openSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function messageStart(response) {
  writeSse(response, {
    type: 'message_start',
    message: {
      id: 'mock-message',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  })
}

function toolCall(response, id, name, argumentsJson) {
  const midpoint = Math.max(1, Math.floor(argumentsJson.length / 2))
  writeSse(response, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
  })
  for (const partial of [
    argumentsJson.slice(0, midpoint),
    argumentsJson.slice(midpoint),
  ]) {
    writeSse(response, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: partial },
    })
  }
  writeSse(response, { type: 'content_block_stop', index: 0 })
  writeSse(response, {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 2 },
  })
  writeSse(response, { type: 'message_stop' })
  response.end()
}

function textReply(response, text) {
  writeSse(response, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  writeSse(response, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })
  writeSse(response, { type: 'content_block_stop', index: 0 })
  writeSse(response, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: [...text].length },
  })
  writeSse(response, { type: 'message_stop' })
  response.end()
}
