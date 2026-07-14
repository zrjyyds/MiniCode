import type { ToolRegistry } from '../tool.js'
import type {
  AgentStep,
  ChatMessage,
  ModelAdapter,
  ProviderUsage,
  StepDiagnostics,
  ToolCall,
} from '../types.js'
import type { ResolvedRealAgentConfig, RealAgentProtocol } from './config.js'
import { readSseJsonEvents } from './sse.js'

type FetchLike = typeof fetch

type AdapterOptions = {
  config: ResolvedRealAgentConfig
  tools: ToolRegistry
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

type JsonObject = Record<string, unknown>

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function retryDelayMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 5000)
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function parseAssistantText(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  const markers = [
    { prefix: '<final>', kind: 'final' as const },
    { prefix: '[FINAL]', kind: 'final' as const },
    { prefix: '<progress>', kind: 'progress' as const },
    { prefix: '[PROGRESS]', kind: 'progress' as const },
  ]
  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const raw = trimmed.slice(marker.prefix.length).trim()
      return {
        content: raw.replace(marker.kind === 'final' ? /<\/final>/gi : /<\/progress>/gi, '').trim(),
        kind: marker.kind,
      }
    }
  }
  return { content: trimmed }
}

function normalizeUsage(
  usage: unknown,
  source: string,
  fields: {
    input: string[]
    output: string[]
    total?: string[]
  },
): ProviderUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const sumFields = (names: string[]) =>
    names.reduce((sum, name) => sum + (typeof record[name] === 'number' ? record[name] : 0), 0)
  const inputTokens = sumFields(fields.input)
  const outputTokens = sumFields(fields.output)
  const explicitTotal = fields.total
    ?.map(name => record[name])
    .find((value): value is number => typeof value === 'number')
  const totalTokens = explicitTotal ?? inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return { inputTokens, outputTokens, totalTokens, source }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: { message: text.trim() } }
  }
}

function extractProviderError(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const error = record.error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message.trim()
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim()
    }
  }
  return `Model request failed: ${status}`
}

async function postJsonWithRetries(args: {
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs: number
  maxRetries: number
  fetchImpl: FetchLike
  sleepImpl: (ms: number) => Promise<void>
}): Promise<{ status: number; ok: boolean; data: unknown }> {
  let last: { status: number; ok: boolean; data: unknown } | null = null
  for (let attempt = 0; attempt <= args.maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const response = await args.fetchImpl(args.url, {
        method: 'POST',
        headers: args.headers,
        body: JSON.stringify(args.body),
        signal: controller.signal,
      })
      const data = await readJson(response)
      last = { status: response.status, ok: response.ok, data }
      if (response.ok || !shouldRetry(response.status) || attempt >= args.maxRetries) {
        return last
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        last = { status: 0, ok: false, data: { error: { message: 'Model request timed out' } } }
      } else {
        throw error instanceof Error ? error : new Error(String(error))
      }
      if (attempt >= args.maxRetries) return last
    } finally {
      clearTimeout(timeout)
    }
    await args.sleepImpl(retryDelayMs(attempt))
  }
  return last ?? { status: 0, ok: false, data: { error: { message: 'Model request failed' } } }
}

function toolDefinitions(tools: ToolRegistry): JsonObject[] {
  return tools.list().map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

function openAiToolDefinitions(tools: ToolRegistry): JsonObject[] {
  return tools.list().map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function openAiResponsesToolDefinitions(tools: ToolRegistry): JsonObject[] {
  return tools.list().map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))
}

function jsonArguments(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function assistantStepFromParts(args: {
  textParts: string[]
  toolCalls: ToolCall[]
  diagnostics: StepDiagnostics
  usage?: ProviderUsage
}): AgentStep {
  const parsed = parseAssistantText(args.textParts.join('\n').trim())
  if (args.toolCalls.length > 0) {
    return {
      type: 'tool_calls',
      calls: args.toolCalls,
      content: parsed.content || undefined,
      contentKind: parsed.kind === 'progress' ? 'progress' : undefined,
      diagnostics: args.diagnostics,
      usage: args.usage,
    }
  }
  return {
    type: 'assistant',
    content: parsed.content,
    kind: parsed.kind,
    diagnostics: args.diagnostics,
    usage: args.usage,
  }
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | JsonObject

function pushAnthropicMessage(
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>,
  role: 'user' | 'assistant',
  block: AnthropicBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === role) {
    last.content.push(block)
  } else {
    messages.push({ role, content: [block] })
  }
}

function toAnthropicPayload(messages: ChatMessage[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>
} {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')
  const converted: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') pushAnthropicMessage(converted, 'user', { type: 'text', text: message.content })
    else if (message.role === 'assistant' || message.role === 'assistant_progress') pushAnthropicMessage(converted, 'assistant', { type: 'text', text: message.content })
    else if (message.role === 'assistant_tool_call') pushAnthropicMessage(converted, 'assistant', { type: 'tool_use', id: message.toolUseId, name: message.toolName, input: message.input })
    else if (message.role === 'tool_result') pushAnthropicMessage(converted, 'user', { type: 'tool_result', tool_use_id: message.toolUseId, content: message.content, is_error: message.isError })
    else if (message.role === 'context_summary') pushAnthropicMessage(converted, 'user', { type: 'text', text: `[Context Summary]\n${message.content}` })
  }
  return { system, messages: converted }
}

export class AnthropicMessagesRealAdapter implements ModelAdapter {
  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>

  constructor(private readonly options: AdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleepImpl = options.sleep ?? sleep
  }

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const payload = toAnthropicPayload(messages)
    const response = await postJsonWithRetries({
      url: `${this.options.config.baseUrl.replace(/\/$/, '')}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': this.options.config.apiKey,
      },
      body: {
        model: this.options.config.model,
        system: payload.system,
        messages: payload.messages,
        tools: toolDefinitions(this.options.tools),
        max_tokens: this.options.config.maxOutputTokens,
      },
      timeoutMs: this.options.config.requestTimeoutMs,
      maxRetries: this.options.config.maxRetries,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    })
    if (!response.ok) throw new Error(extractProviderError(response.data, response.status))
    const data = response.data as { content?: AnthropicBlock[]; stop_reason?: string; usage?: unknown }
    const textParts: string[] = []
    const toolCalls: ToolCall[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()
    for (const block of data.content ?? []) {
      const type = typeof block.type === 'string' ? block.type : 'unknown'
      blockTypes.push(type)
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        textParts.push((block as { text: string }).text)
      } else if (block.type === 'tool_use') {
        const typed = block as { id?: unknown; name?: unknown; input?: unknown }
        if (typeof typed.id === 'string' && typeof typed.name === 'string') {
          toolCalls.push({ id: typed.id, toolName: typed.name, input: typed.input })
        } else {
          ignoredBlockTypes.add(type)
        }
      } else {
        ignoredBlockTypes.add(type)
      }
    }
    return assistantStepFromParts({
      textParts,
      toolCalls,
      diagnostics: { stopReason: data.stop_reason, blockTypes, ignoredBlockTypes: [...ignoredBlockTypes] },
      usage: normalizeUsage(data.usage, 'anthropic', {
        input: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'],
        output: ['output_tokens'],
      }),
    })
  }
}

function toOpenAiChatMessages(messages: ChatMessage[]): JsonObject[] {
  const converted: JsonObject[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      converted.push({ role: message.role, content: message.content })
    } else if (message.role === 'assistant' || message.role === 'assistant_progress') {
      converted.push({ role: 'assistant', content: message.content })
    } else if (message.role === 'assistant_tool_call') {
      converted.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: message.toolUseId,
          type: 'function',
          function: { name: message.toolName, arguments: jsonArguments(message.input) },
        }],
      })
    } else if (message.role === 'tool_result') {
      converted.push({
        role: 'tool',
        tool_call_id: message.toolUseId,
        content: message.content,
      })
    } else if (message.role === 'context_summary') {
      converted.push({ role: 'user', content: `[Context Summary]\n${message.content}` })
    }
  }
  return converted
}

export class OpenAIChatCompletionsRealAdapter implements ModelAdapter {
  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>

  constructor(private readonly options: AdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleepImpl = options.sleep ?? sleep
  }

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    if (this.options.config.stream) return this.nextStream(messages)

    const response = await postJsonWithRetries({
      url: `${this.options.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${this.options.config.apiKey}`,
      },
      body: {
        model: this.options.config.model,
        messages: toOpenAiChatMessages(messages),
        tools: openAiToolDefinitions(this.options.tools),
        max_tokens: this.options.config.maxOutputTokens,
      },
      timeoutMs: this.options.config.requestTimeoutMs,
      maxRetries: this.options.config.maxRetries,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    })
    if (!response.ok) throw new Error(extractProviderError(response.data, response.status))
    const data = response.data as { choices?: Array<{ finish_reason?: string; message?: JsonObject }>; usage?: unknown }
    const choice = data.choices?.[0]
    const message = choice?.message ?? {}
    const text = typeof message.content === 'string' ? message.content : ''
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap(call => {
          if (!call || typeof call !== 'object') return []
          const record = call as JsonObject
          const fn = record.function as JsonObject | undefined
          if (typeof record.id !== 'string' || typeof fn?.name !== 'string') return []
          return [{
            id: record.id,
            toolName: fn.name,
            input: parseArguments(fn.arguments),
          }]
        })
      : []
    return assistantStepFromParts({
      textParts: [text],
      toolCalls,
      diagnostics: { stopReason: choice?.finish_reason },
      usage: normalizeUsage(data.usage, 'openai-chat-completions', {
        input: ['prompt_tokens'],
        output: ['completion_tokens'],
        total: ['total_tokens'],
      }),
    })
  }

  private async nextStream(messages: ChatMessage[]): Promise<AgentStep> {
    const body: JsonObject = {
      model: this.options.config.model,
      messages: toOpenAiChatMessages(messages),
      tools: openAiToolDefinitions(this.options.tools),
      max_tokens: this.options.config.maxOutputTokens,
      stream: true,
    }
    if (this.options.config.streamIncludeUsage) {
      body.stream_options = { include_usage: true }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.config.requestTimeoutMs)
    try {
      const response = await this.fetchImpl(`${this.options.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${this.options.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const events = await readSseJsonEvents(response)
      return openAiChatStepFromStreamEvents(events, this.options.config.streamToolCallIdPrefix)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('SSE stream request timed out')
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timeout)
    }
  }
}

type StreamToolCallAccumulator = {
  id: string
  type?: string
  name: string
  arguments: string
}

function parseStreamToolArguments(value: string, toolName: string): unknown {
  if (!value.trim()) throw new Error(`Invalid streamed tool arguments for ${toolName || 'unknown tool'}: empty JSON`)
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`Invalid streamed tool arguments JSON for ${toolName || 'unknown tool'}`)
  }
}

function normalizeStreamToolCallId(id: string, index: number, prefix?: string): string {
  const fallback = id || `stream-tool-${index}`
  if (!prefix) return fallback
  const loosePrefix = prefix.endsWith('_') ? prefix.slice(0, -1) : prefix
  return fallback.startsWith(prefix) || fallback.startsWith(loosePrefix) ? fallback : `${prefix}${fallback}`
}

function openAiChatStepFromStreamEvents(events: Array<{ data: unknown }>, toolCallIdPrefix?: string): AgentStep {
  const textParts: string[] = []
  const blockTypes: string[] = []
  const toolCalls = new Map<number, StreamToolCallAccumulator>()
  let stopReason: string | undefined
  let usage: ProviderUsage | undefined

  for (const event of events) {
    const data = event.data
    if (!data || typeof data !== 'object') continue
    usage = normalizeUsage((data as { usage?: unknown }).usage, 'openai-chat-completions-stream', {
      input: ['prompt_tokens'],
      output: ['completion_tokens'],
      total: ['total_tokens'],
    }) ?? usage
    const choices = (data as { choices?: unknown }).choices
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const finishReason = (choice as { finish_reason?: unknown }).finish_reason
      if (typeof finishReason === 'string') stopReason = finishReason
      const delta = (choice as { delta?: unknown }).delta
      if (!delta || typeof delta !== 'object') continue

      const content = (delta as { content?: unknown }).content
      if (typeof content === 'string') {
        blockTypes.push('delta_content')
        if (content.length > 0) textParts.push(content)
      }

      const deltaToolCalls = (delta as { tool_calls?: unknown }).tool_calls
      if (Array.isArray(deltaToolCalls)) {
        blockTypes.push('delta_tool_calls')
        for (const fallback of deltaToolCalls.keys()) {
          const toolDelta = deltaToolCalls[fallback]
          if (!toolDelta || typeof toolDelta !== 'object') continue
          const index = typeof (toolDelta as { index?: unknown }).index === 'number'
            ? (toolDelta as { index: number }).index
            : fallback
          const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
          const id = (toolDelta as { id?: unknown }).id
          if (typeof id === 'string') current.id += id
          const type = (toolDelta as { type?: unknown }).type
          if (typeof type === 'string') current.type = type
          const fn = (toolDelta as { function?: unknown }).function
          if (fn && typeof fn === 'object') {
            const name = (fn as { name?: unknown }).name
            if (typeof name === 'string') current.name += name
            const args = (fn as { arguments?: unknown }).arguments
            if (typeof args === 'string') current.arguments += args
          }
          toolCalls.set(index, current)
        }
      }
    }
  }

  const calls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => {
      const toolName = call.name
      return {
        id: normalizeStreamToolCallId(call.id, index, toolCallIdPrefix),
        toolName,
        input: parseStreamToolArguments(call.arguments, toolName),
      }
    })

  return assistantStepFromParts({
    textParts: textParts.length > 0 ? [textParts.join('')] : [],
    toolCalls: calls,
    diagnostics: { stopReason, blockTypes },
    usage,
  })
}

function toOpenAiResponsesInput(messages: ChatMessage[]): JsonObject[] {
  const input: JsonObject[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      input.push({ role: message.role, content: message.content })
    } else if (message.role === 'assistant' || message.role === 'assistant_progress') {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
    } else if (message.role === 'assistant_tool_call') {
      input.push({
        type: 'function_call',
        call_id: message.toolUseId,
        name: message.toolName,
        arguments: jsonArguments(message.input),
      })
    } else if (message.role === 'tool_result') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolUseId,
        output: message.content,
      })
    } else if (message.role === 'context_summary') {
      input.push({ role: 'user', content: `[Context Summary]\n${message.content}` })
    }
  }
  return input
}

export class OpenAIResponsesRealAdapter implements ModelAdapter {
  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>

  constructor(private readonly options: AdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleepImpl = options.sleep ?? sleep
  }

  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const response = await postJsonWithRetries({
      url: `${this.options.config.baseUrl.replace(/\/$/, '')}/v1/responses`,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${this.options.config.apiKey}`,
      },
      body: {
        model: this.options.config.model,
        input: toOpenAiResponsesInput(messages),
        tools: openAiResponsesToolDefinitions(this.options.tools),
        max_output_tokens: this.options.config.maxOutputTokens,
      },
      timeoutMs: this.options.config.requestTimeoutMs,
      maxRetries: this.options.config.maxRetries,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    })
    if (!response.ok) throw new Error(extractProviderError(response.data, response.status))
    const data = response.data as { output?: JsonObject[]; status?: string; usage?: unknown }
    const textParts: string[] = []
    const toolCalls: ToolCall[] = []
    const blockTypes: string[] = []
    for (const item of data.output ?? []) {
      const type = typeof item.type === 'string' ? item.type : 'unknown'
      blockTypes.push(type)
      if (type === 'message' && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (
            content &&
            typeof content === 'object' &&
            (content as JsonObject).type === 'output_text' &&
            typeof (content as JsonObject).text === 'string'
          ) {
            textParts.push((content as { text: string }).text)
          }
        }
      } else if (type === 'function_call') {
        if (typeof item.call_id === 'string' && typeof item.name === 'string') {
          toolCalls.push({
            id: item.call_id,
            toolName: item.name,
            input: parseArguments(item.arguments),
          })
        }
      }
    }
    return assistantStepFromParts({
      textParts,
      toolCalls,
      diagnostics: { stopReason: data.status, blockTypes },
      usage: normalizeUsage(data.usage, 'openai-responses', {
        input: ['input_tokens'],
        output: ['output_tokens'],
        total: ['total_tokens'],
      }),
    })
  }
}

export function createRealAgentAdapter(args: AdapterOptions): ModelAdapter {
  const protocol = args.config.protocol
  if (protocol === 'anthropic-messages' || protocol === 'auto') {
    return new AnthropicMessagesRealAdapter(args)
  }
  if (protocol === 'openai-responses') {
    return new OpenAIResponsesRealAdapter(args)
  }
  if (protocol === 'openai-chat-completions') {
    return new OpenAIChatCompletionsRealAdapter(args)
  }
  const unreachable: never = protocol
  throw new Error(`Unknown real agent provider protocol: ${unreachable}`)
}

export function realAgentProtocolLabel(protocol: RealAgentProtocol): string {
  return protocol === 'auto' ? 'auto (Anthropic Messages default)' : protocol
}
