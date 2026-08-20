import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  encryptMessage,
  pollOast,
  redactSecrets,
  registerOast,
  renderSafe,
  type FetchLike,
  type OastStore,
} from './client.ts'

function jsonFetch(
  handler: (url: string, init?: Parameters<FetchLike>[1]) => { status: number; body: unknown },
): FetchLike {
  return async (url, init) => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const { status, body } = handler(url, init)
    return { status, text: async () => JSON.stringify(body) }
  }
}

describe('oast_register', () => {
  it('POSTs /register with public-key, secret-key, correlation-id and returns id/url/domain', async () => {
    let url = ''
    let headers: Record<string, string> | undefined
    let posted: Record<string, string> = {}
    const store: OastStore = new Map()
    const fetchImpl = jsonFetch((u, init) => {
      url = u
      headers = init?.headers
      posted = init?.body ? JSON.parse(init.body) as Record<string, string> : {}
      return { status: 200, body: { message: 'registration successful' } }
    })
    const result = await registerOast(
      { kind: 'http' },
      {
        fetch: fetchImpl,
        store,
        env: { INTERACTSH_URL: 'http://interactsh:80', INTERACTSH_TOKEN: 'neo-oast' },
      },
    )
    assert.equal(url, 'http://interactsh:80/register')
    assert.equal(headers?.Authorization, 'neo-oast')
    assert.ok(posted['public-key'])
    assert.ok(posted['secret-key'])
    assert.ok(posted['correlation-id'])
    assert.equal(result.id, posted['correlation-id'])
    assert.match(result.domain, new RegExp(`^${result.id}[0-9a-v]{13}\\.interactsh$`))
    assert.equal(result.url, `http://${result.domain}`)
    assert.equal('secretKey' in result, false)
    const session = store.get(result.id)
    assert.ok(session)
    assert.notEqual(JSON.stringify(result).includes(session.secretKey), true)
  })

  it('dns kind returns a hostname url without http scheme', async () => {
    const store: OastStore = new Map()
    const fetchImpl = jsonFetch(() => ({ status: 200, body: { message: 'registration successful' } }))
    const result = await registerOast(
      { kind: 'dns' },
      { fetch: fetchImpl, store, env: { INTERACTSH_URL: 'http://interactsh:80' } },
    )
    assert.equal(result.url, result.domain)
    assert.equal(result.url.startsWith('http'), false)
  })
})

describe('oast_poll', () => {
  it('polls with id+secret query and parses extra plaintext interactions', async () => {
    const store: OastStore = new Map()
    const fetchImpl = jsonFetch((url, init) => {
      if (url.endsWith('/register')) {
        return { status: 200, body: { message: 'registration successful' } }
      }
      assert.match(url, /\/poll\?id=/)
      assert.match(url, /secret=/)
      assert.equal(init?.headers?.Authorization, 'tok')
      assert.equal(url.includes('tok'), false)
      return {
        status: 200,
        body: {
          data: [],
          extra: [
            JSON.stringify({
              protocol: 'http',
              'unique-id': 'abc',
              'full-id': 'abc.interactsh',
              'raw-request': 'GET / HTTP/1.1',
              'remote-address': '1.2.3.4',
              timestamp: '2026-08-20T00:00:00Z',
            }),
          ],
        },
      }
    })
    const reg = await registerOast(
      { kind: 'http' },
      { fetch: fetchImpl, store, env: { INTERACTSH_TOKEN: 'tok', INTERACTSH_URL: 'http://interactsh' } },
    )
    const hits = await pollOast({ id: reg.id }, {
      fetch: fetchImpl,
      store,
      env: { INTERACTSH_TOKEN: 'tok', INTERACTSH_URL: 'http://interactsh' },
    })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.protocol, 'http')
    assert.equal(hits[0]?.uniqueId, 'abc')
    assert.equal(hits[0]?.rawRequest, 'GET / HTTP/1.1')
  })

  it('decrypts AES-CTR poll data using the session private key', async () => {
    const store: OastStore = new Map()
    const fetchImpl = jsonFetch((url) => {
      if (url.endsWith('/register')) return { status: 200, body: { message: 'registration successful' } }
      const session = [...store.values()][0]
      assert.ok(session)
      const payload = JSON.stringify({
        protocol: 'dns',
        'unique-id': session.id,
        'full-id': `${session.id}nonce.interactsh`,
        'q-type': 'A',
        'remote-address': '9.9.9.9',
        timestamp: '2026-08-20T01:00:00Z',
      })
      const enc = encryptMessage(session.publicKeyPem, payload)
      return { status: 200, body: { data: [enc.data], aes_key: enc.aesKey, extra: [] } }
    })
    const reg = await registerOast({ kind: 'dns' }, { fetch: fetchImpl, store, env: {} })
    const hits = await pollOast({ id: reg.id }, { fetch: fetchImpl, store, env: {} })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.protocol, 'dns')
    assert.equal(hits[0]?.qType, 'A')
    assert.equal(hits[0]?.remoteAddress, '9.9.9.9')
  })

  it('wait_seconds retries until an interaction arrives', async () => {
    const store: OastStore = new Map()
    let polls = 0
    let t = 0
    const fetchImpl = jsonFetch((url) => {
      if (url.endsWith('/register')) return { status: 200, body: { message: 'registration successful' } }
      polls += 1
      if (polls < 3) return { status: 200, body: { data: [], extra: [] } }
      return {
        status: 200,
        body: {
          extra: [
            JSON.stringify({
              protocol: 'http',
              'unique-id': 'z',
              'full-id': 'z',
              'remote-address': '127.0.0.1',
              timestamp: 't',
            }),
          ],
        },
      }
    })
    const reg = await registerOast({ kind: 'http' }, { fetch: fetchImpl, store, env: {} })
    const hits = await pollOast({ id: reg.id, wait_seconds: 5 }, {
      fetch: fetchImpl,
      store,
      env: {},
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    assert.equal(polls, 3)
    assert.equal(hits[0]?.uniqueId, 'z')
  })
})

describe('secret redaction', () => {
  it('never renders secret-key, token, or private key material', () => {
    const rendered = renderSafe({}, {
      id: 'cid',
      url: 'http://cidnonce.interactsh',
      domain: 'cidnonce.interactsh',
      secretKey: 'should-not-appear',
      token: 'neo-oast',
      Authorization: 'neo-oast',
      privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----',
    })
    const text = rendered[0]?.text ?? ''
    assert.match(text, /\[redacted\]/)
    assert.equal(text.includes('should-not-appear'), false)
    assert.equal(text.includes('neo-oast'), false)
    assert.equal(text.includes('BEGIN RSA PRIVATE KEY'), false)
    const redacted = redactSecrets({ INTERACTSH_TOKEN: 'neo-oast', nested: { 'secret-key': 'x' } }) as {
      INTERACTSH_TOKEN: string
      nested: { 'secret-key': string }
    }
    assert.equal(redacted.INTERACTSH_TOKEN, '[redacted]')
    assert.equal(redacted.nested['secret-key'], '[redacted]')
  })
})
