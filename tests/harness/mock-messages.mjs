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
    if (requests.length > 80) {
      res.writeHead(500); res.end('mock loop'); return
    }
    const names = toolNames(body)
    const serialized = JSON.stringify(body)
    const child = names.has('structured_output')
    const marker = child
      ? ['DIRECT', 'PLANNER', 'NESTED', 'SWARM', 'STREAM_A', 'STREAM_B']
          .find((id) => JSON.stringify(body.messages?.find((m) => m.role === 'user') ?? body).includes(`HARNESS_ROLE_${id}`))
      : 'ROOT'
    const id = marker ?? 'UNKNOWN'
    const prior = new Set((body.messages ?? []).flatMap((m) => m.content ?? [])
      .filter((c) => c.type === 'tool_use').map((c) => c.id))
    const call = (step, name, args) => toolCall(res, `${id}-${step}`, name, JSON.stringify(args))
    const did = (step) => prior.has(`${id}-${step}`)
    branches[id] = (branches[id] ?? 0) + 1
    openSse(res)
    messageStart(res)
    if (serialized.includes('Structured output recorded')) {
      branches.child_settled += 1; textReply(res, 'child settled'); return
    }
    if (child) {
      const required = id === 'PLANNER' || id === 'SWARM'
        ? ['delegate', 'read', 'structured_output']
        : ['sandbox_exec', 'read', 'write', 'structured_output']
      const missing = required.filter((n) => !names.has(n))
      if (missing.length) {
        branches.missing = [...(branches.missing ?? []), { id, missing, tools: [...names] }]
        textReply(res, `HARNESS_MISSING_TOOLS ${id}: ${missing.join(', ')}`); return
      }
      if (id === 'PLANNER' && !did('nested')) {
        call('nested', 'delegate', { agent_id: 'explore', prompt: 'HARNESS_ROLE_NESTED Execute fixture work and return structured output.' }); return
      }
      if (id === 'SWARM' && !did('parallel')) {
        call('parallel', 'delegate', { agent_id: 'recon', prompt: 'fixture streams', parallel_group: [
          { agent_id: 'recon', prompt: 'HARNESS_ROLE_STREAM_A Execute fixture work and return structured output.' },
          { agent_id: 'recon', prompt: 'HARNESS_ROLE_STREAM_B Execute fixture work and return structured output.' },
        ] }); return
      }
      if (id !== 'PLANNER' && id !== 'SWARM') {
        if (!did('write')) { call('write', 'write', { file_path: `${id}.txt`, content: `HARNESS_FILE_${id}` }); return }
        if (!did('read')) { call('read', 'read', { file_path: `${id}.txt` }); return }
        if (!did('exec')) { call('exec', 'sandbox_exec', { command: `cat ${id}.txt; printf HARNESS_EXEC_${id} > ${id}.exec.txt` }); return }
        if (!did('artifact')) { call('artifact', 'read', { file_path: `${id}.exec.txt` }); return }
      }
      const ok = id === 'PLANNER' ? serialized.includes('HARNESS_DONE_NESTED')
        : id === 'SWARM' ? serialized.includes('HARNESS_DONE_STREAM_A') && serialized.includes('HARNESS_DONE_STREAM_B')
        : serialized.includes(`HARNESS_FILE_${id}`) && serialized.includes(`HARNESS_EXEC_${id}`)
      // Only tool results establish success: the mock prompt and issued calls also contain markers.
      const results = JSON.stringify((body.messages ?? []).flatMap((m) => m.content ?? []).filter((c) => c.type === 'tool_result'))
      const useful = (id === 'PLANNER' || id === 'SWARM') ? ok
        : results.includes(`HARNESS_FILE_${id}`) && results.includes(`HARNESS_EXEC_${id}`) && !results.includes('Neo blocks')
      branches[`verified_${id}`] = useful
      servedStructuredOutput = true
      call('output', 'structured_output', { summary: useful ? `HARNESS_DONE_${id}` : `HARNESS_FAILED_${id}`, artifacts: [] }); return
    }
    if (!did('shell')) { branches.shell_guard++; call('shell', 'bash', { command: 'echo GUARD_MUST_BLOCK_THIS' }); return }
    if (!did('file')) { branches.file_guard++; call('file', 'read', { file_path: '/etc/passwd' }); return }
    for (const [step, agent_id, role] of [['direct', 'explore', 'DIRECT'], ['planner', 'planner', 'PLANNER'], ['swarm', 'swarm', 'SWARM']]) {
      if (!did(step)) { call(step, 'delegate', { agent_id, prompt: `HARNESS_ROLE_${role} Execute fixture work and return structured output.` }); return }
    }
    const success = ['DIRECT', 'PLANNER', 'SWARM'].every((id) => serialized.includes(`HARNESS_DONE_${id}`))
    branches.parent_ok += Number(success)
    branches.parent_failure += Number(!success)
    textReply(res, success ? 'parent received HARNESS_WORKFLOW_OK' : 'parent received failure')
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
