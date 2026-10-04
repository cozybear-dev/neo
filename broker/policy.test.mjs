import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validId, validateCompose } from './policy.mjs'
test('reject traversal before filesystem operations', () => {
  for (const id of ['../../outside', '/tmp/x', 'a b', 'A', ''])
    assert.throws(() => validId(id))
  assert.equal(validId('lab-123'), 'lab-123')
})
test('reject policy escapes in concrete effective Compose', () => {
  for (const field of [
    'privileged',
    'network_mode',
    'pid',
    'ipc',
    'volumes',
    'ports',
    'devices',
    'cap_add',
    'build',
    'networks',
    'user',
    'security_opt',
    'container_name',
  ])
    assert.throws(
      () =>
        validateCompose({
          services: { app: { image: 'fixture:v1', [field]: true } },
        }),
      field,
    )
  for (const field of ['include', 'volumes', 'networks', 'configs', 'secrets'])
    assert.throws(() =>
      validateCompose({
        services: { app: { image: 'fixture:v1' } },
        [field]: {},
      }),
    )
})
test('accept constrained image argv spec', () =>
  assert.equal(
    validateCompose({
      services: {
        app: {
          image: 'fixture@sha256:123',
          command: ['node', 'app.js'],
          expose: ['3000'],
        },
      },
    })[0].name,
    'app',
  ))
