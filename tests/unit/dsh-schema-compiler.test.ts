import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compileValueSchema, compileParameters, validateValue } from '../helpers/dsh-schema.ts'

describe('DSH ValueSchemaSpec compiler (pin 141eb6f)', () => {
  it('rejects additionalProperties as a nested schema', () => {
    assert.throws(
      () => compileValueSchema({
        type: 'object',
        additionalProperties: { type: 'string' },
        properties: { headers: { type: 'object', additionalProperties: { type: 'string' } } },
      }),
      /additionalProperties must be explicitly true or false/,
    )
  })

  it('rejects a property with no type and no oneOf', () => {
    assert.throws(
      () => compileValueSchema({
        type: 'object',
        additionalProperties: true,
        properties: { result: {} },
      }),
      /type must be string\/number\/integer\/boolean\/null\/array\/object\/json, or use oneOf/,
    )
  })

  it('rejects object items without additionalProperties', () => {
    assert.throws(
      () => compileValueSchema({
        type: 'array',
        items: { type: 'object' },
      }),
      /additionalProperties must be explicitly true or false/,
    )
  })

  it('accepts type json on a property', () => {
    compileValueSchema({
      type: 'object',
      additionalProperties: true,
      properties: { result: { type: 'json' } },
    })
  })

  it('accepts boolean additionalProperties true/false', () => {
    compileValueSchema({
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean', required: true, const: true } },
    })
  })

  it('parameter root stays open (no additionalProperties required)', () => {
    compileParameters({
      command: { type: 'string', required: true },
      env: { type: 'object', additionalProperties: true },
    })
  })

  it('validates additionalProperties false against extra keys', () => {
    const schema = compileValueSchema({
      type: 'object',
      additionalProperties: false,
      properties: { stdout: { type: 'string', required: true } },
    })
    const violations = validateValue(schema, { stdout: 'ok', extra: 1 })
    assert.ok(violations.some((v) => /not a declared property/.test(v)))
  })
})
