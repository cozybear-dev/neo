import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, redactText } from './redact.mjs'
test('redacts embedded JSON, form bodies, bearer auth, URL credentials and known environment secrets', () => {
  const value = {
    body: JSON.stringify({
      password: 'hidden-json',
      nested: { access_token: 'hidden-token' },
    }),
    form: 'username=user&password=hidden-form',
    raw: 'Authorization: Bearer hidden-bearer\nCookie: hidden-cookie',
    url: 'https://user:hidden-userinfo@example.test/?api_key=hidden-query',
    plain: 'hidden-env',
  }
  const text = JSON.stringify(redactSecrets(value, ['hidden-env']))
  assert.doesNotMatch(text, /hidden-/)
  assert.equal(redactText('public information'), 'public information')
  assert.equal(
    redactText('{"password":"hidden-json"}'),
    '{"password":"[redacted]"}',
  )
})
