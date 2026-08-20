import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appendTraffic,
  assertSameDestination,
  replayTraffic,
  searchTraffic,
  type CapturedRequest,
  type FetchLike,
  type FsLike,
} from './client.ts'

function memFs(seed: Record<string, string> = {}): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) {
      files.set(path, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    },
    async readFile(path) {
      const v = files.get(path)
      if (v === undefined) {
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      return v
    },
    async appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data)
    },
  }
}

const sample: CapturedRequest = {
  id: 'req-1',
  method: 'POST',
  url: 'http://juice-shop.lab.internal/rest/user/login',
  headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
  postData: '{"email":"a@b.c"}',
  status: 200,
  timestamp: '2026-08-20T00:00:00.000Z',
}

describe('traffic_search', () => {
  it('greps jsonl records', async () => {
    const fs = memFs()
    await appendTraffic(sample, { fs, trafficPath: '/workspace/traffic/http.jsonl' })
    await appendTraffic(
      { ...sample, id: 'req-2', method: 'GET', url: 'http://juice-shop.lab.internal/api/Users' },
      { fs, trafficPath: '/workspace/traffic/http.jsonl' },
    )
    const hits = await searchTraffic(
      { query: 'login' },
      { fs, trafficPath: '/workspace/traffic/http.jsonl' },
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.id, 'req-1')
  })

  it('returns empty when the log is missing', async () => {
    const hits = await searchTraffic({ query: 'x' }, { fs: memFs(), trafficPath: '/workspace/traffic/http.jsonl' })
    assert.deepEqual(hits, [])
  })
})

describe('traffic_replay', () => {
  it('replays the original method/url/headers/body', async () => {
    const fs = memFs()
    await appendTraffic(sample, { fs, trafficPath: '/workspace/traffic/http.jsonl' })
    let got: { url: string; init?: Parameters<FetchLike>[1] } | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      got = { url, init }
      return { status: 201, headers: { 'content-type': 'application/json' }, text: async () => '{"ok":true}' }
    }
    const res = await replayTraffic(
      { id: 'req-1' },
      { fs, trafficPath: '/workspace/traffic/http.jsonl', fetch: fetchImpl },
    )
    assert.equal(got?.url, sample.url)
    assert.equal(got?.init?.method, 'POST')
    assert.equal(got?.init?.body, '{"email":"a@b.c"}')
    assert.equal(got?.init?.headers?.['content-type'], 'application/json')
    assert.equal(res.status, 201)
    assert.equal(res.body, '{"ok":true}')
  })

  it('applies header and body edits', async () => {
    const fs = memFs()
    await appendTraffic(sample, { fs, trafficPath: '/workspace/traffic/http.jsonl' })
    let body: string | undefined
    let headers: Record<string, string> | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      body = init?.body
      headers = init?.headers
      return { status: 200, text: async () => 'ok' }
    }
    await replayTraffic(
      { id: 'req-1', edits: { body: '{"email":"x@y.z"}', headers: { 'x-test': '1' } } },
      { fs, trafficPath: '/workspace/traffic/http.jsonl', fetch: fetchImpl },
    )
    assert.equal(body, '{"email":"x@y.z"}')
    assert.equal(headers?.['x-test'], '1')
  })

  it('rejects destination host changes (Neo replay pin)', async () => {
    const fs = memFs()
    await appendTraffic(sample, { fs, trafficPath: '/workspace/traffic/http.jsonl' })
    await assert.rejects(
      () => replayTraffic(
        { id: 'req-1', edits: { url: 'http://evil.example/rest/user/login' } },
        { fs, trafficPath: '/workspace/traffic/http.jsonl', fetch: async () => ({ status: 200, text: async () => '' }) },
      ),
      /destination host must stay the original/,
    )
    await assert.rejects(
      () => replayTraffic(
        { id: 'req-1', edits: { host: 'evil.example' } },
        { fs, trafficPath: '/workspace/traffic/http.jsonl', fetch: async () => ({ status: 200, text: async () => '' }) },
      ),
      /destination host must stay the original/,
    )
  })

  it('allows same-host path edits', () => {
    assertSameDestination(
      'http://juice-shop.lab.internal/a',
      'http://juice-shop.lab.internal/b?q=1',
    )
  })

  it('throws when id is missing', async () => {
    await assert.rejects(
      () => replayTraffic({ id: 'nope' }, { fs: memFs(), trafficPath: '/workspace/traffic/http.jsonl' }),
      /not found/,
    )
  })

  it('honors abort signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => replayTraffic({ id: 'req-1' }, { signal: ac.signal, fs: memFs() }),
      (err: unknown) => (err as Error).name === 'AbortError',
    )
  })
})
