import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { REDACTED, redactTraceValue } from '../src/debug/trace-redaction.js'

describe('trace redaction', () => {
  it('redacts sensitive token fields while preserving token statistics', () => {
    const input = {
      token: 'secret-token',
      token_count: 42,
      max_tokens: 100,
      totalTokens: 142,
    }

    const output = redactTraceValue(input) as typeof input

    assert.equal(output.token, REDACTED)
    assert.equal(output.token_count, 42)
    assert.equal(output.max_tokens, 100)
    assert.equal(output.totalTokens, 142)
  })

  it('redacts bearer tokens and common environment variable assignments', () => {
    const output = redactTraceValue([
      'Authorization: Bearer abc.def.ghi',
      'OPENAI_API_KEY=sk-test-value',
      'GITHUB_TOKEN=ghp_test',
    ])

    assert.deepEqual(output, [
      `Authorization: Bearer ${REDACTED}`,
      `OPENAI_API_KEY=${REDACTED}`,
      `GITHUB_TOKEN=${REDACTED}`,
    ])
  })

  it('recursively redacts nested objects without mutating the original value', () => {
    const input = {
      nested: {
        authorization: 'Bearer nested-secret',
        safe: 'visible',
      },
      array: [{ password: 'pw' }],
    }

    const output = redactTraceValue(input) as {
      nested: { authorization: string; safe: string }
      array: Array<{ password: string }>
    }

    assert.equal(output.nested.authorization, REDACTED)
    assert.equal(output.nested.safe, 'visible')
    assert.equal(output.array[0]?.password, REDACTED)
    assert.equal(input.nested.authorization, 'Bearer nested-secret')
    assert.equal(input.array[0]?.password, 'pw')
  })
})
