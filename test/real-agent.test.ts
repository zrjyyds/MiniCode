import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgentTurn } from '../src/agent-loop.js'
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
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'

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

function readFileCall(id: string): AgentStep {
  return {
    type: 'tool_calls',
    calls: [{ id, toolName: 'read_file', input: { path: 'README.md' } }],
  }
}

function writeFileCall(id: string, fileName: string): AgentStep {
  return {
    type: 'tool_calls',
    calls: [{
      id,
      toolName: 'write_file',
      input: { path: `outputs/${fileName}`, content: fileName },
    }],
  }
}

function writeFileBatch(ids: string[]): AgentStep {
  return {
    type: 'tool_calls',
    calls: ids.map(id => ({
      id,
      toolName: 'write_file',
      input: { path: `outputs/${id}.txt`, content: id },
    })),
  }
}

function fakeModel(nextStep: () => AgentStep | Promise<AgentStep>): ModelAdapter {
  return { next: nextStep }
}

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
  async function withRealAgentEnv<T>(fn: () => Promise<T>): Promise<T> {
    const names = [
      'MINICODE_TEST_REAL_BASE_URL',
      'MINICODE_TEST_REAL_API_KEY',
      'MINICODE_TEST_REAL_MODEL',
    ]
    const previous = new Map(names.map(name => [name, process.env[name]]))
    process.env.MINICODE_TEST_REAL_BASE_URL = 'https://example.invalid'
    process.env.MINICODE_TEST_REAL_API_KEY = 'secret-value'
    process.env.MINICODE_TEST_REAL_MODEL = 'test-model'
    try {
      return await fn()
    } finally {
      for (const name of names) {
        const value = previous.get(name)
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  }

  async function runFakeLive(args: {
    caseIds: Array<'text-response' | 'read-file'>
    maxRequests: number
    maxToolCalls: number
    modelFactory: () => ModelAdapter
  }) {
    const dir = await tempDir()
    const configPath = path.join(dir, 'real-agent.json')
    const outputDir = path.join(dir, 'out')
    await writeFile(configPath, `${JSON.stringify(config(), null, 2)}\n`, 'utf8')
    const summary = await withRealAgentEnv(() => runAgentLiveEvaluation({
      configPath,
      outputDir,
      caseIds: args.caseIds,
      noSaveRaw: true,
      maxRequests: args.maxRequests,
      maxToolCalls: args.maxToolCalls,
      timeoutMs: 1000,
      modelFactory: args.modelFactory,
    }))
    return { summary, outputDir }
  }

  async function assertMissing(filePath: string): Promise<void> {
    await assert.rejects(
      () => readFile(filePath, 'utf8'),
      error => error instanceof Error && 'code' in error && error.code === 'ENOENT',
    )
  }

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

  it('preserves failed case accounting after successful tool use and later model failure', async () => {
    let actualModelCalls = 0
    const { summary } = await runFakeLive({
      caseIds: ['read-file'],
      maxRequests: 10,
      maxToolCalls: 10,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        if (actualModelCalls === 1) return readFileCall('read-1')
        throw new Error('fetch failed')
      }),
    })

    const result = summary.results[0]!
    assert.equal(result.status, 'failed')
    assert.equal(result.requests, 2)
    assert.equal(result.toolCalls, 1)
    assert.equal(summary.metrics.requests, 2)
    assert.equal(summary.metrics.toolCalls, 1)
    assert.equal(actualModelCalls, 2)
  })

  it('enforces the global request budget before issuing another model request', async () => {
    let actualModelCalls = 0
    const { summary } = await runFakeLive({
      caseIds: ['read-file'],
      maxRequests: 2,
      maxToolCalls: 10,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return readFileCall(`read-${actualModelCalls}`)
      }),
    })

    const result = summary.results[0]!
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'LIVE_AGENT_REQUEST_BUDGET_EXCEEDED')
    assert.equal(result.requests, 2)
    assert.equal(summary.metrics.requests, 2)
    assert.equal(actualModelCalls, 2)
  })

  it('marks later cases skipped after a critical case exhausts request budget', async () => {
    let actualModelCalls = 0
    const { summary } = await runFakeLive({
      caseIds: ['text-response', 'read-file'],
      maxRequests: 1,
      maxToolCalls: 10,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return readFileCall(`read-${actualModelCalls}`)
      }),
    })

    assert.equal(summary.results.length, 2)
    assert.equal(summary.results[0]?.caseId, 'text-response')
    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(summary.results[0]?.errorCode, 'LIVE_AGENT_REQUEST_BUDGET_EXCEEDED')
    assert.equal(summary.results[0]?.requests, 1)
    assert.equal(summary.results[1]?.caseId, 'read-file')
    assert.equal(summary.results[1]?.status, 'skipped')
    assert.equal(summary.results[1]?.errorCode, 'LIVE_AGENT_BUDGET_EXCEEDED')
    assert.equal(summary.results[1]?.requests, 0)
    assert.equal(summary.results[1]?.toolCalls, 0)
    assert.equal(summary.metrics.requests, 1)
    assert.equal(actualModelCalls, 1)
  })

  it('enforces the global tool-call budget before executing another tool', async () => {
    let actualModelCalls = 0
    const { summary, outputDir } = await runFakeLive({
      caseIds: ['read-file'],
      maxRequests: 10,
      maxToolCalls: 2,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return writeFileCall(`write-${actualModelCalls}`, `tool-${actualModelCalls}.txt`)
      }),
    })
    const workspace = path.join(outputDir, 'read-file', 'acceptance-workspace')

    const result = summary.results[0]!
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'LIVE_AGENT_TOOL_CALL_BUDGET_EXCEEDED')
    assert.equal(result.toolCalls, 2)
    assert.equal(summary.metrics.toolCalls, 2)
    assert.equal(actualModelCalls, 3)
    assert.equal(await readFile(path.join(workspace, 'outputs', 'tool-1.txt'), 'utf8'), 'tool-1.txt')
    assert.equal(await readFile(path.join(workspace, 'outputs', 'tool-2.txt'), 'utf8'), 'tool-2.txt')
    await assertMissing(path.join(workspace, 'outputs', 'tool-3.txt'))
  })

  it('marks later cases skipped after a critical case exhausts tool-call budget', async () => {
    let actualModelCalls = 0
    const { summary, outputDir } = await runFakeLive({
      caseIds: ['text-response', 'read-file'],
      maxRequests: 10,
      maxToolCalls: 1,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return writeFileCall(`write-${actualModelCalls}`, `critical-tool-${actualModelCalls}.txt`)
      }),
    })
    const workspace = path.join(outputDir, 'text-response', 'acceptance-workspace')

    assert.equal(summary.results.length, 2)
    assert.equal(summary.results[0]?.caseId, 'text-response')
    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(summary.results[0]?.errorCode, 'LIVE_AGENT_TOOL_CALL_BUDGET_EXCEEDED')
    assert.equal(summary.results[0]?.toolCalls, 1)
    assert.equal(summary.results[1]?.caseId, 'read-file')
    assert.equal(summary.results[1]?.status, 'skipped')
    assert.equal(summary.results[1]?.errorCode, 'LIVE_AGENT_BUDGET_EXCEEDED')
    assert.equal(summary.results[1]?.requests, 0)
    assert.equal(summary.results[1]?.toolCalls, 0)
    assert.equal(summary.metrics.toolCalls, 1)
    assert.equal(actualModelCalls, 2)
    assert.equal(await readFile(path.join(workspace, 'outputs', 'critical-tool-1.txt'), 'utf8'), 'critical-tool-1.txt')
    await assertMissing(path.join(workspace, 'outputs', 'critical-tool-2.txt'))
  })

  it('does not exceed tool budget when one model response returns too many tool calls', async () => {
    let actualModelCalls = 0
    const { summary, outputDir } = await runFakeLive({
      caseIds: ['read-file'],
      maxRequests: 10,
      maxToolCalls: 2,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return writeFileBatch(['batch-1', 'batch-2', 'batch-3', 'batch-4'])
      }),
    })
    const workspace = path.join(outputDir, 'read-file', 'acceptance-workspace')

    const result = summary.results[0]!
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'LIVE_AGENT_TOOL_CALL_BUDGET_EXCEEDED')
    assert.equal(result.requests, 1)
    assert.equal(result.toolCalls, 2)
    assert.equal(summary.metrics.toolCalls, 2)
    assert.equal(actualModelCalls, 1)
    assert.equal(await readFile(path.join(workspace, 'outputs', 'batch-1.txt'), 'utf8'), 'batch-1')
    assert.equal(await readFile(path.join(workspace, 'outputs', 'batch-2.txt'), 'utf8'), 'batch-2')
    await assertMissing(path.join(workspace, 'outputs', 'batch-3.txt'))
    await assertMissing(path.join(workspace, 'outputs', 'batch-4.txt'))
  })

  it('does not expose partial assistant_tool_call messages when tool budget aborts a batch', async () => {
    let executedTools = 0
    let allowedToolStarts = 0
    const messagesUpdated: ChatMessage[][] = []
    const registry = new ToolRegistry([{
      name: 'counted_tool',
      description: 'count executions',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      schema: z.object({ value: z.string() }),
      async run(input: { value: string }) {
        executedTools += 1
        return { ok: true, output: input.value }
      },
    }])
    const budgetError = new Error('tool budget exhausted')
    budgetError.name = 'LIVE_AGENT_TOOL_CALL_BUDGET_EXCEEDED'

    await assert.rejects(
      () => runAgentTurn({
        model: fakeModel(() => ({
          type: 'tool_calls',
          calls: ['one', 'two', 'three', 'four'].map(value => ({
            id: value,
            toolName: 'counted_tool',
            input: { value },
          })),
        })),
        tools: registry,
        messages,
        cwd: process.cwd(),
        maxSteps: 4,
        onToolStart() {
          if (allowedToolStarts >= 2) throw budgetError
          allowedToolStarts += 1
        },
        observer: {
          onEvent(event) {
            if (event.event_type === 'messages_updated' && Array.isArray(event.messages)) {
              messagesUpdated.push(event.messages as ChatMessage[])
            }
          },
        },
      }),
      error => error instanceof Error && error.name === 'LIVE_AGENT_TOOL_CALL_BUDGET_EXCEEDED',
    )

    assert.equal(executedTools, 2)
    assert.equal(allowedToolStarts, 2)
    for (const snapshot of messagesUpdated) {
      const toolCalls = snapshot.filter(message => message.role === 'assistant_tool_call')
      for (const call of toolCalls) {
        assert.ok(snapshot.some(message =>
          message.role === 'tool_result' &&
          message.toolUseId === call.toolUseId,
        ))
      }
    }
    assert.equal(
      messagesUpdated.some(snapshot => snapshot.some(message => message.role === 'assistant_tool_call')),
      false,
    )
  })

  it('skips later cases once the global budget is exhausted at a case boundary', async () => {
    let actualModelCalls = 0
    const { summary } = await runFakeLive({
      caseIds: ['text-response', 'read-file'],
      maxRequests: 1,
      maxToolCalls: 10,
      modelFactory: () => fakeModel(async () => {
        actualModelCalls += 1
        return { type: 'assistant', content: 'done' }
      }),
    })

    assert.equal(summary.results.length, 2)
    assert.equal(summary.results[0]?.status, 'passed')
    assert.equal(summary.results[0]?.requests, 1)
    assert.equal(summary.results[1]?.status, 'skipped')
    assert.equal(summary.results[1]?.errorCode, 'LIVE_AGENT_BUDGET_EXCEEDED')
    assert.equal(summary.results[1]?.requests, 0)
    assert.equal(summary.results[1]?.toolCalls, 0)
    assert.equal(summary.metrics.requests, 1)
    assert.equal(actualModelCalls, 1)
  })
})
