import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createIssue, queryIssues, updateIssue, type FetchLike } from './client.ts'

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

describe('issue_create', () => {
  it('returns {ok:false,error} for thorough without confirmed (does not throw)', async () => {
    const fetchImpl = jsonFetch((_url, init) => {
      const body = init?.body ? JSON.parse(init.body) as { verdict?: string } : {}
      assert.notEqual(body.verdict, 'confirmed')
      return { status: 400, body: { error: 'thorough mode requires verdict=confirmed' } }
    })
    const result = await createIssue(
      {
        title: 'maybe xss',
        severity: 'high',
        host: 'app.lab.internal',
        evidence_paths: ['/workspace/p.png'],
        reproduction: 'open /',
        verdict: 'unverified',
        task_id: 'thorough-task',
      },
      { fetch: fetchImpl, env: {} },
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /verdict=confirmed/)
    }
  })

  it('returns {ok:true,id} when control accepts a confirmed finding', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 201,
      body: { id: 'issue-1', status: 'confirmed', verdict: 'confirmed' },
    }))
    const result = await createIssue(
      { title: 'xss', severity: 'high', verdict: 'confirmed', task_id: 't1' },
      { fetch: fetchImpl, env: {} },
    )
    assert.deepEqual(result, { ok: true, id: 'issue-1' })
  })

  it('throws on infrastructure (5xx) failures', async () => {
    const fetchImpl = jsonFetch(() => ({ status: 502, body: { error: 'bad gateway' } }))
    await assert.rejects(
      () => createIssue({ title: 'x', severity: 'low', verdict: 'confirmed' }, { fetch: fetchImpl, env: {} }),
      /bad gateway/,
    )
  })
})

describe('issue_query / issue_update', () => {
  it('issue_query returns the issues array and forwards filters', async () => {
    let url = ''
    const fetchImpl = jsonFetch((u) => {
      url = u
      return {
        status: 200,
        body: { issues: [{ id: 'i1', title: 'xss', severity: 'high', status: 'confirmed', host: 'app.lab.internal' }] },
      }
    })
    const issues = await queryIssues(
      { host: 'app.lab.internal', severity: 'high', status: 'confirmed' },
      { fetch: fetchImpl, env: { CONTROL_URL: 'http://control:8090' } },
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.id, 'i1')
    assert.match(url, /host=app.lab.internal/)
    assert.match(url, /severity=high/)
    assert.match(url, /status=confirmed/)
  })

  it('issue_update returns {ok:true} and sends status + comment', async () => {
    let posted: unknown
    const fetchImpl = jsonFetch((url, init) => {
      assert.equal(url, 'http://control:8090/issues/issue-1')
      assert.equal(init?.method, 'PATCH')
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { id: 'issue-1', status: 'false_positive' } }
    })
    const result = await updateIssue(
      { id: 'issue-1', status: 'false_positive', comment: 'nope' },
      { fetch: fetchImpl, env: {} },
    )
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(posted, { status: 'false_positive', comment: 'nope' })
  })

  it('omits non-uuid task_id and falls back to session UUID', async () => {
    let url = ''
    const fetchImpl = jsonFetch((u) => {
      url = u
      return { status: 200, body: { issues: [] } }
    })
    await queryIssues(
      { task_id: 'session-ef2b412d-nope' },
      {
        fetch: fetchImpl,
        env: {},
        agent: { id: 'session-ef2b412d-84ac-4cde-8330-bdfd04154c78' },
      },
    )
    assert.match(url, /task_id=ef2b412d-84ac-4cde-8330-bdfd04154c78/)
    assert.doesNotMatch(url, /session-ef2b412d-nope/)
  })
})
