import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/types.js'
import {
  HarnessTraceRecorder,
  readTraceEvents,
  summarizeMessages,
} from '../src/debug/harness-trace.js'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-trace-test-'))
}

describe('harness trace recorder', () => {
  it('writes monotonic JSONL events with a stable run id', async () => {
    const outputDir = await tempDir()
    const recorder = new HarnessTraceRecorder({
      outputDir,
      scenario: 'unit',
      modelName: 'mock',
    })
    await recorder.init()

    const first = await recorder.record({ event_type: 'run_started', turn_index: 0 })
    const second = await recorder.record({
      event_type: 'turn_completed',
      turn_index: 1,
      termination_reason: 'assistant_final',
    })
    await recorder.close()

    const events = await readTraceEvents(recorder.jsonlPath)
    assert.equal(events.length, 2)
    assert.equal(first.run_id, second.run_id)
    assert.deepEqual(events.map(event => event.sequence), [1, 2])
    assert.deepEqual(events.map(event => event.event_type), ['run_started', 'turn_completed'])
  })

  it('summarizes messages in summary mode and keeps full redacted values in full mode', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Authorization: Bearer abc123' },
    ]

    const summary = summarizeMessages(messages, 'summary')
    const full = summarizeMessages(messages, 'full')

    assert.equal(summary.messages[1]?.value, undefined)
    assert.equal(summary.messages[1]?.preview, 'Authorization: Bearer [REDACTED]')
    assert.deepEqual(full.messages[1]?.value, {
      role: 'user',
      content: 'Authorization: Bearer [REDACTED]',
    })
  })

  it('generates markdown summary and snapshots without leaking test keys', async () => {
    const outputDir = await tempDir()
    const recorder = new HarnessTraceRecorder({
      outputDir,
      scenario: 'summary',
      modelName: 'mock',
      mode: 'summary',
    })
    await recorder.init()

    await recorder.record({ event_type: 'run_started', turn_index: 0 })
    await recorder.record({
      event_type: 'model_request',
      turn_index: 1,
      message_count: 1,
      message_roles: ['user'],
      model_messages: [{ role: 'user', content: 'OPENAI_API_KEY=sk-test' }],
    })
    await recorder.record({
      event_type: 'messages_updated',
      turn_index: 1,
      message_count: 2,
      message_roles: ['user', 'assistant'],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'done' },
      ],
    })
    await recorder.record({
      event_type: 'turn_completed',
      turn_index: 1,
      termination_reason: 'assistant_final',
    })
    await recorder.close()

    const markdown = await readFile(recorder.summaryPath, 'utf8')
    const snapshot = await readFile(
      path.join(recorder.snapshotsDir, 'turn-01-model-input.json'),
      'utf8',
    )

    assert.match(markdown, /user -> assistant/)
    assert.match(markdown, /assistant_final/)
    assert.ok(!snapshot.includes('sk-test'))
    assert.ok(snapshot.includes('[REDACTED]'))
  })

  it('throws after close', async () => {
    const recorder = new HarnessTraceRecorder({
      outputDir: await tempDir(),
      scenario: 'closed',
      modelName: 'mock',
    })
    await recorder.init()
    await recorder.close()

    await assert.rejects(
      recorder.record({ event_type: 'run_started', turn_index: 0 }),
      /closed/,
    )
  })
})
