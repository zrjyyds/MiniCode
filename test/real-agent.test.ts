import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgentLiveEvaluation } from '../src/evaluation/agent-live.js'
import {
  AnthropicMessagesRealAdapter,
  OpenAIChatCompletionsRealAdapter,
  OpenAIResponsesRealAdapter,
  resolveRealAgentConfig,
  validateRealAgentConfig,
} from '../src/real-agent/index.js'
import { ToolRegistry } from '../src/tool.js'
import type { ChatMessage } from '../src/types.js'

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-real-agent-test-'))
}

function config() {
  return validateRealAgentConfig({
    schemaVersion: '1.0',
    protocol: 'anthropic-messages',
    baseUrlEnv: 'MINICODE_TEST_REAL_BASE_URL',
    apiKeyEnv: 'MINICODE_TEST_REAL_API_KEY',
    modelEnv: 'MINICODE_TEST_REAL_MODEL',
    requestTimeoutMs: 1000,
    maxOutputTokens: 128,
    maxRetries: 1,
  })
}

function resolved(protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions') {
  return {
    ...resolveRealAgentConfig({ ...config(), protocol }, 'test-config.json', {
      MINICODE_TEST_REAL_BASE_URL: 'https://example.invalid',
      MINICODE_TEST_REAL_API_KEY: 'secret-value',
      MINICODE_TEST_REAL_MODEL: 'test-model',
    }),
    protocol,
  }
}

function tools(): ToolRegistry {
  return new ToolRegistry([{
    name: 'read_file',
    description: 'read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    schema: z.object({ path: z.string() }),
    async run() {
      return { ok: true, output: 'ok' }
    },
  }])
}

const messages: ChatMessage[] = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'read README.md' },
]

describe('real agent config', () => {
  it('resolves only explicit MINICODE_REAL-style env names', () => {
    const runtime = resolveRealAgentConfig(config(), 'config.json', {
      MINICODE_TEST_REAL_BASE_URL: 'https://example.invalid',
      MINICODE_TEST_REAL_API_KEY: 'secret-value',
      MINICODE_TEST_REAL_MODEL: 'model-a',
      ANTHROPIC_API_KEY: 'ignored',
    })
    assert.equal(runtime.model, 'model-a')
    assert.equal(runtime.apiKey, 'secret-value')
  })

  it('reports missing explicit environment variables without values', () => {
    assert.throws(
      () => resolveRealAgentConfig(config(), 'config.json', {}),
      /MINICODE_TEST_REAL_BASE_URL.*MINICODE_TEST_REAL_API_KEY.*MINICODE_TEST_REAL_MODEL/,
    )
  })
})

describe('real agent adapters', () => {
  it('parses Anthropic Messages tool_use blocks', async () => {
    const adapter = new AnthropicMessagesRealAdapter({
      config: resolved('anthropic-messages'),
      tools: tools(),
      fetchImpl: async () => new Response(JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'README.md' } }],
        usage: { input_tokens: 3, output_tokens: 4 },
      }), { status: 200 }),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].toolName : '', 'read_file')
    assert.equal(step.usage?.totalTokens, 7)
  })

  it('parses OpenAI Responses function_call items', async () => {
    const adapter = new OpenAIResponsesRealAdapter({
      config: resolved('openai-responses'),
      tools: tools(),
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'requires_action',
        output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }), { status: 200 }),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].toolName : '', 'read_file')
    assert.equal(step.usage?.source, 'openai-responses')
  })

  it('parses OpenAI Chat Completions tool_calls', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: resolved('openai-chat-completions'),
      tools: tools(),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }), { status: 200 }),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].toolName : '', 'read_file')
    assert.equal(step.usage?.source, 'openai-chat-completions')
  })
})

describe('agent live evaluation', () => {
  it('dry-runs ten live cases without requiring environment credentials', async () => {
    const dir = await tempDir()
    const configPath = path.join(dir, 'real-agent.json')
    await writeFile(configPath, `${JSON.stringify(config(), null, 2)}\n`, 'utf8')
    const summary = await runAgentLiveEvaluation({
      configPath,
      outputDir: path.join(dir, 'out'),
      all: true,
      dryRun: true,
      noSaveRaw: true,
      maxRequests: 30,
      maxToolCalls: 20,
      timeoutMs: 1000,
    })
    assert.equal(summary.results.length, 10)
    assert.equal(summary.metrics.skipped, 10)
  })
})
