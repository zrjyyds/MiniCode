import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { RuntimeConfig } from '../src/config.js'
import { createAcceptanceWorkspace } from '../src/evaluation/acceptance-workspace.js'
import {
  assertAcceptanceMcpReady,
  createAcceptanceMcpServers,
  runAgentLiveEvaluation,
} from '../src/evaluation/agent-live.js'
import {
  AnthropicMessagesRealAdapter,
  OpenAIChatCompletionsRealAdapter,
  OpenAIResponsesRealAdapter,
  resolveRealAgentConfig,
  validateRealAgentConfig,
} from '../src/real-agent/index.js'
import { ToolRegistry } from '../src/tool.js'
import { createDefaultToolRegistry, hydrateMcpTools } from '../src/tools/index.js'
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

function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers as Record<string, string> | undefined) },
    ...init,
  })
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

const done = 'data: [DONE]\n\n'

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

  it('parses streamed OpenAI Chat Completions text chunks', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { role: 'assistant' } }] }),
        sse({ choices: [{ delta: { content: 'MINICODE_' } }] }),
        sse({ choices: [{ delta: { content: 'REAL_MODEL_OK' }, finish_reason: 'stop' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'assistant')
    assert.equal(step.type === 'assistant' ? step.content : '', 'MINICODE_REAL_MODEL_OK')
    assert.equal(step.diagnostics?.stopReason, 'stop')
  })

  it('parses streamed events across network chunk boundaries', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => {
        const payload = `${sse({ choices: [{ delta: { content: 'hel' } }] }).replace(/\n/g, '\r\n')}${sse({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }).replace(/\n/g, '\r\n')}data: [DONE]\r\n\r\n`
        return streamResponse([payload.slice(0, 12), payload.slice(12, 55), payload.slice(55)])
      },
    })
    const step = await adapter.next(messages)
    assert.equal(step.type === 'assistant' ? step.content : '', 'hello')
  })

  it('parses CRLF split across network chunk boundaries without false event boundary', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => {
        const payload = [
          'data: {"choices":[',
          'data: {"delta":{"content":"ok"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\r\n')
        const splitAt = payload.indexOf('\r\n')
        assert.notEqual(splitAt, -1)
        return streamResponse([payload.slice(0, splitAt + 1), payload.slice(splitAt + 1)])
      },
    })
    const step = await adapter.next(messages)
    assert.equal(step.type === 'assistant' ? step.content : '', 'ok')
  })

  it('parses multiple streamed events in one network chunk', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        `${sse({ choices: [{ delta: { content: 'a' } }] })}${sse({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] })}${done}`,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type === 'assistant' ? step.content : '', 'ab')
  })

  it('ignores empty streamed content chunks without failing', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { content: '' } }] }),
        sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type === 'assistant' ? step.content : '', 'ok')
  })

  it('aggregates streamed tool calls with fragmented name and arguments', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].toolName : '', 'read_file')
    assert.deepEqual(step.type === 'tool_calls' ? step.calls[0].input : {}, { path: 'README.md' })
  })

  it('aggregates multiple streamed tool calls by index', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { tool_calls: [
          { index: 1, id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          { index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ] }, finish_reason: 'tool_calls' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.deepEqual(step.type === 'tool_calls' ? step.calls.map(call => call.id) : [], ['call-1', 'call-2'])
  })

  it('optionally prefixes streamed tool call ids for compatible providers', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true, streamToolCallIdPrefix: 'fc_' },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].id : '', 'fc_call-1')
  })

  it('does not duplicate a complete streamed tool call id prefix', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true, streamToolCallIdPrefix: 'fc_' },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fc_call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }),
        done,
      ]),
    })
    const step = await adapter.next(messages)
    assert.equal(step.type, 'tool_calls')
    assert.equal(step.type === 'tool_calls' ? step.calls[0].id : '', 'fc_call-1')
  })

  it('rejects invalid streamed tool arguments before execution', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: 'tool_calls' }] }),
        done,
      ]),
    })
    await assert.rejects(() => adapter.next(messages), /Invalid streamed tool arguments JSON/)
  })

  it('streams final text after tool result refill', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> }
        assert.equal(body.messages.some(message => message.role === 'tool'), true)
        return streamResponse([
          sse({ choices: [{ delta: { content: 'final answer' }, finish_reason: 'stop' }] }),
          done,
        ])
      },
    })
    const step = await adapter.next([
      ...messages,
      { role: 'assistant_tool_call', toolUseId: 'call-1', toolName: 'read_file', input: { path: 'README.md' } },
      { role: 'tool_result', toolUseId: 'call-1', toolName: 'read_file', content: 'MiniCode', isError: false },
    ])
    assert.equal(step.type === 'assistant' ? step.content : '', 'final answer')
  })

  it('reports non-2xx JSON errors without raw responses', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'server unavailable' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    })
    await assert.rejects(() => adapter.next(messages), /SSE request failed: server unavailable/)
  })

  it('rejects non-SSE successful responses', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    })
    await assert.rejects(() => adapter.next(messages), /Expected text\/event-stream/)
  })

  it('rejects streams that end before DONE', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse([sse({ choices: [{ delta: { content: 'partial' } }] })]),
    })
    await assert.rejects(() => adapter.next(messages), /ended before \[DONE\]/)
  })

  it('rejects a streamed response that times out while reading', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true, requestTimeoutMs: 25 },
      tools: tools(),
      fetchImpl: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('stream aborted by timeout', 'AbortError'))
          })
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    })
    await assert.rejects(
      () => adapter.next(messages),
      error => error instanceof Error &&
        /timeout|aborted|AbortError/i.test(error.message) &&
        !error.message.includes('secret-value'),
    )
  })

  it('redacts invalid SSE JSON diagnostics', async () => {
    const adapter = new OpenAIChatCompletionsRealAdapter({
      config: { ...resolved('openai-chat-completions'), stream: true },
      tools: tools(),
      fetchImpl: async () => streamResponse(['data: {"token":"sk-this-secret-should-not-appear"\n\n', done]),
    })
    await assert.rejects(
      () => adapter.next(messages),
      error => error instanceof Error &&
        /Invalid SSE JSON event/.test(error.message) &&
        !error.message.includes('sk-this-secret-should-not-appear'),
    )
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

  it('hydrates the call-local-mcp acceptance server from the MiniCode project root', async () => {
    const dir = await tempDir()
    const workspace = await createAcceptanceWorkspace(path.join(dir, 'acceptance-workspace'))
    const mcpServerScript = path.resolve('scripts', 'test-mcp-server.ts')
    const projectRoot = path.dirname(path.dirname(mcpServerScript))
    const mcpServers = createAcceptanceMcpServers({ mcpServerScript, workspace })
    assert.equal(mcpServers.acceptance?.cwd, projectRoot)
    assert.notEqual(mcpServers.acceptance?.cwd, workspace)

    const runtime: RuntimeConfig = {
      model: 'test-model',
      baseUrl: 'https://example.invalid',
      apiKey: 'secret-value',
      maxOutputTokens: 128,
      sourceSummary: 'test runtime',
      mcpServers,
    }
    const registry = await createDefaultToolRegistry({ cwd: workspace, runtime })
    try {
      await hydrateMcpTools({ cwd: workspace, runtime, tools: registry })
      assertAcceptanceMcpReady(registry)
      const server = registry.getMcpServers().find(entry => entry.name === 'acceptance')
      assert.equal(server?.status, 'connected')
      assert.equal(server?.toolCount, 2)
      assert.ok(registry.find('mcp__acceptance__get_project_summary'))
      assert.ok(registry.find('mcp__acceptance__count_workspace_files'))
    } finally {
      await registry.dispose()
    }
  })
})
