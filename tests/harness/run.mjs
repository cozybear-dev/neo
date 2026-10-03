import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { DeepSeekHarness } from '/opt/dsh/packages/sdk/client/lib/index.js'
import { startMockMessages } from './mock-messages.mjs'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const HOME = process.env.DSH_HOME || '/tmp/neo-harness-dsh'
const WORK = process.env.NEO_WORKSPACE || '/tmp/neo-harness-workspace'
const WORKHORSE_KEYS = [
  'NEO_LLM_WORKHORSE_PROVIDER',
  'NEO_LLM_WORKHORSE_MODEL',
  'NEO_LLM_WORKHORSE_API_KEY',
  'NEO_LLM_WORKHORSE_BASE_URL',
  'NEO_LLM_WORKHORSE_API',
  'NEO_LLM_WORKHORSE_API_KEY_ENV',
  'NEO_LLM_WORKHORSE_REASONING_EFFORT',
  'NEO_RESOLVED_WORKHORSE_PROVIDER',
  'NEO_RESOLVED_WORKHORSE_MODEL',
  'NEO_RESOLVED_WORKHORSE_REASONING_EFFORT',
]

function startControl() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && /^\/tasks\/[^/]+\/memory$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ insights: [], facts: [], todos: [], files: [] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close() {
          return new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}

function ensureToolLink() {
  const dir = `${HOME}/profiles/node_modules/@deepseek-ai`
  const link = `${dir}/dsh-tools`
  mkdirSync(dir, { recursive: true })
  if (!existsSync(link)) symlinkSync('/opt/dsh/packages/core/tools', link)
  const nodePath = process.env.NODE_PATH ?? ''
  const entry = `${HOME}/profiles/node_modules`
  if (!nodePath.split(':').includes(entry)) {
    process.env.NODE_PATH = nodePath === '' ? entry : `${entry}:${nodePath}`
  }
}

async function main() {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  const control = await startControl()
  const mock = await startMockMessages()
  process.env.CONTROL_URL = control.origin
  process.env.NEO_TASK_ID = TASK_ID
  process.env.NEO_WORKSPACE = WORK
  process.env.NEO_PRESETS_DIR = process.env.NEO_PRESETS_DIR || '/opt/neo/presets'
  process.env.DEEPSEEK_BASE_URL = mock.url
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'mock-key'
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'
  for (const key of WORKHORSE_KEYS) delete process.env[key]
  ensureToolLink()

  const harness = new DeepSeekHarness({
    profile: 'sdk',
    patches: ['/opt/neo/tests/harness/cordis.patch.yml'],
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    initializeTimeoutMs: 60000,
    dshHome: HOME,
    cwd: WORK,
    processCwd: WORK,
  })

  let result
  let failed
  try {
    result = await Promise.race([
      harness.run('Use the delegate tool once for the explore specialist.'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('harness timed out after 90s')), 90000)
      }),
    ])
  } catch (error) {
    failed = error
  } finally {
    await harness.close().catch(() => {})
    await mock.close()
    await control.close()
  }

  const finalResponse = result?.finalResponse ?? ''
  const sawMemory = mock.requests.some((body) => JSON.stringify(body).includes('Shared task memory'))
  const passed = failed == null
    && finalResponse.includes('parent received HARNESS_CHILD_OK')
    && sawMemory
    && mock.servedStructuredOutput
  if (!passed) {
    console.error('Harness failed.')
    console.error(`finalResponse: ${redact(finalResponse)}`)
    console.error(`branches: ${JSON.stringify(mock.branches)}`)
    console.error(`servedStructuredOutput: ${mock.servedStructuredOutput}`)
    console.error(`sawMemory: ${sawMemory}`)
    console.error(`requestCount: ${mock.requests.length}`)
    for (const note of result?.notifications ?? []) {
      if (note.method !== 'subagent.finished') continue
      const params = note.params ?? {}
      console.error(`note subagent.finished: status=${redact(params.status)} stopReason=${redact(params.stopReason)}`)
    }
    if (failed != null) console.error(`error: ${redact(failed instanceof Error ? `${failed.name}: ${failed.message}` : failed)}`)
    process.exit(1)
  }
  console.log('Harness passed: parent received the explore child summary.')
}

function redact(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/(api[_-]?key|token|authorization|secret)(['"\s:=]+)[^\s'"]+/gi, '$1$2[redacted]')
    .slice(0, 1200)
}

await main()
