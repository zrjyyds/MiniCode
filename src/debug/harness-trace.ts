import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentStep, ChatMessage } from '../types.js'
import { redactTraceValue } from './trace-redaction.js'

export type TraceMode = 'summary' | 'full'

export type HarnessTraceEventType =
  | 'run_started'
  | 'turn_started'
  | 'context_prepared'
  | 'compaction_checked'
  | 'compaction_applied'
  | 'model_request'
  | 'model_response'
  | 'tool_call_started'
  | 'permission_decision'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'tool_result_replaced'
  | 'messages_updated'
  | 'turn_completed'
  | 'run_failed'
  | 'run_completed'

export type HarnessTraceEvent = {
  schema_version: 1
  run_id: string
  sequence: number
  event_type: HarnessTraceEventType
  timestamp: string
  turn_index: number
  [key: string]: unknown
}

export type AgentLoopTraceEvent = Omit<
  HarnessTraceEvent,
  'schema_version' | 'run_id' | 'sequence' | 'timestamp'
>

export type AgentLoopObserver = {
  onEvent(event: AgentLoopTraceEvent): void | Promise<void>
}

export type MessageSnapshot = {
  kind: 'model_visible' | 'transcript'
  mode: TraceMode
  message_count: number
  message_roles: string[]
  total_content_length: number
  messages: Array<{
    role: string
    content_length?: number
    preview?: string
    value?: unknown
  }>
}

export type HarnessTraceRecorderOptions = {
  outputDir: string
  runId?: string
  scenario: string
  modelName: string
  mode?: TraceMode
  printEvents?: boolean
}

function messageContentLength(message: ChatMessage): number {
  if ('content' in message && typeof message.content === 'string') {
    return message.content.length
  }
  if (message.role === 'assistant_tool_call') {
    return JSON.stringify(message.input).length
  }
  if (message.role === 'assistant_thinking') {
    return JSON.stringify(message.blocks).length
  }
  return JSON.stringify(message).length
}

function preview(value: string, limit = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}...`
}

export function summarizeMessages(
  messages: ChatMessage[],
  mode: TraceMode,
  kind: MessageSnapshot['kind'] = 'model_visible',
): MessageSnapshot {
  return {
    kind,
    mode,
    message_count: messages.length,
    message_roles: messages.map(message => message.role),
    total_content_length: messages.reduce((sum, message) => sum + messageContentLength(message), 0),
    messages: messages.map(message => {
      if (mode === 'full') {
        return {
          role: message.role,
          value: redactTraceValue(message),
        }
      }

      const raw =
        'content' in message && typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message)
      return {
        role: message.role,
        content_length: messageContentLength(message),
        preview: preview(String(redactTraceValue(raw))),
      }
    }),
  }
}

function responseSummary(response: AgentStep): Record<string, unknown> {
  if (response.type === 'assistant') {
    return {
      response_type: response.type,
      content_length: response.content.length,
      content_preview: preview(String(redactTraceValue(response.content))),
      kind: response.kind,
      diagnostics: response.diagnostics,
    }
  }

  return {
    response_type: response.type,
    content_length: response.content?.length ?? 0,
    content_preview: response.content ? preview(String(redactTraceValue(response.content))) : undefined,
    tool_call_count: response.calls.length,
    tool_calls: response.calls.map(call => ({
      id: call.id,
      tool_name: call.toolName,
      input: redactTraceValue(call.input),
    })),
    diagnostics: response.diagnostics,
  }
}

export function summarizeModelResponse(response: AgentStep): Record<string, unknown> {
  return responseSummary(response)
}

function extractPersistedPath(content: string): string | undefined {
  const match = /Full output saved to:\s*(.+)/.exec(content)
  return match?.[1]?.trim()
}

export function summarizeToolResult(content: string): Record<string, unknown> {
  const storagePath = extractPersistedPath(content)
  return {
    length: content.length,
    preview: preview(String(redactTraceValue(content))),
    stored_externally: Boolean(storagePath),
    tool_result_storage_path: storagePath,
  }
}

export class HarnessTraceRecorder implements AgentLoopObserver {
  readonly runId: string
  readonly jsonlPath: string
  readonly summaryPath: string
  readonly snapshotsDir: string
  private sequence = 0
  private closed = false
  private readonly events: HarnessTraceEvent[] = []
  private readonly startedAt = new Date().toISOString()
  private finalStatus = 'running'

  constructor(private readonly options: HarnessTraceRecorderOptions) {
    this.runId = options.runId ?? randomUUID()
    this.jsonlPath = path.join(options.outputDir, 'trace.jsonl')
    this.summaryPath = path.join(options.outputDir, 'trace-summary.md')
    this.snapshotsDir = path.join(options.outputDir, 'snapshots')
  }

  get mode(): TraceMode {
    return this.options.mode ?? 'summary'
  }

  async init(): Promise<void> {
    await mkdir(this.options.outputDir, { recursive: true })
    await mkdir(this.snapshotsDir, { recursive: true })
    await writeFile(this.jsonlPath, '', 'utf8')
  }

  async onEvent(event: AgentLoopTraceEvent): Promise<void> {
    await this.record(event)
  }

  async record(event: AgentLoopTraceEvent): Promise<HarnessTraceEvent> {
    if (this.closed) {
      throw new Error('Trace recorder is closed.')
    }

    const traceEvent = this.prepareEvent(event)
    const fullEvent = {
      schema_version: 1,
      run_id: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...traceEvent,
    } as HarnessTraceEvent

    if (fullEvent.event_type === 'run_completed') {
      this.finalStatus = 'completed'
    } else if (fullEvent.event_type === 'run_failed') {
      this.finalStatus = 'failed'
    }

    this.events.push(fullEvent)
    await appendFile(this.jsonlPath, `${JSON.stringify(fullEvent)}\n`, 'utf8')
    await this.writeSnapshotForEvent(fullEvent)

    if (this.options.printEvents) {
      printConciseEvent(fullEvent)
    }

    return fullEvent
  }

  async flush(): Promise<void> {
    await this.writeSummary()
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.flush()
    this.closed = true
  }

  private async writeSummary(): Promise<void> {
    const roles = this.events
      .filter(event => event.event_type === 'messages_updated')
      .at(-1)?.message_roles as string[] | undefined
    const toolEvents = this.events.filter(event =>
      event.event_type === 'tool_call_completed' || event.event_type === 'tool_call_failed')
    const errors = this.events.filter(event => event.event_type === 'run_failed' || event.event_type === 'tool_call_failed')
    const compactions = this.events.filter(event => event.event_type === 'compaction_applied')
    const termination = [...this.events].reverse().find(event =>
      event.event_type === 'turn_completed' || event.event_type === 'run_completed')

    const turns = this.events
      .filter(event => event.event_type === 'turn_completed')
      .map(event => {
        const turn = event.turn_index
        const requests = this.events.filter(item => item.event_type === 'model_request' && item.turn_index === turn)
        const responses = this.events.filter(item => item.event_type === 'model_response' && item.turn_index === turn)
        const tools = toolEvents.filter(item => item.turn_index === turn)
        const compaction = compactions.filter(item => item.turn_index === turn)
        return `| ${turn} | ${requests.at(-1)?.message_count ?? 0} | ${responses.at(-1)?.response_type ?? 'n/a'} | ${tools.map(t => t.tool_name).join(', ') || 'none'} | ${tools.map(t => t.ok === false ? 'failed' : 'success').join(', ') || 'none'} | ${compaction.map(c => c.compaction_type).join(', ') || 'none'} | ${event.termination_reason ?? 'unknown'} |`
      })

    const content = [
      '# Agent Harness Trace',
      '',
      '## Run信息',
      `- run_id: ${this.runId}`,
      `- scenario: ${this.options.scenario}`,
      `- model: ${this.options.modelName}`,
      `- started_at: ${this.startedAt}`,
      `- completed_at: ${new Date().toISOString()}`,
      `- final_status: ${this.finalStatus}`,
      '',
      '## 每轮概览',
      '| Turn | Model输入消息数 | 模型响应 | Tool | Tool结果 | 压缩 | 状态 |',
      '|---|---:|---|---|---|---|---|',
      ...(turns.length > 0 ? turns : ['| 0 | 0 | n/a | none | none | none | no turns |']),
      '',
      '## 完整角色序列',
      roles?.join(' -> ') ?? 'n/a',
      '',
      '## 工具调用',
      ...(toolEvents.length > 0
        ? toolEvents.map(event => `- turn ${event.turn_index}: ${event.tool_name} ${event.event_type === 'tool_call_failed' ? 'failed' : 'success'} (${event.result_length ?? 0} chars)`)
        : ['- none']),
      '',
      '## 压缩变化',
      ...(compactions.length > 0
        ? compactions.map(event => `- turn ${event.turn_index}: ${event.compaction_type} ${event.before_count ?? '?'} -> ${event.after_count ?? '?'}`)
        : ['- none']),
      '',
      '## 错误',
      ...(errors.length > 0
        ? errors.map(event => `- ${event.event_type}: ${event.error_message ?? event.tool_name ?? 'unknown'}`)
        : ['- none']),
      '',
      '## 终止原因',
      String(termination?.termination_reason ?? 'unknown'),
      '',
    ].join('\n')

    await writeFile(this.summaryPath, content, 'utf8')
  }

  private prepareEvent(event: AgentLoopTraceEvent): AgentLoopTraceEvent {
    const eventCopy = {
      ...event,
    }

    if (Array.isArray(event.model_messages)) {
      eventCopy.model_messages = summarizeMessages(
        event.model_messages as ChatMessage[],
        this.mode,
        'model_visible',
      )
    }

    if (Array.isArray(event.messages)) {
      eventCopy.messages = summarizeMessages(
        event.messages as ChatMessage[],
        this.mode,
        'transcript',
      )
    }

    if (event.response && typeof event.response === 'object') {
      eventCopy.response = this.mode === 'full'
        ? redactTraceValue(event.response)
        : summarizeModelResponse(event.response as AgentStep)
    }

    if (typeof event.result_preview === 'string') {
      eventCopy.tool_result_summary = summarizeToolResult(event.result_preview)
      delete eventCopy.result_preview
    }

    return redactTraceValue(eventCopy) as AgentLoopTraceEvent
  }

  private async writeSnapshotForEvent(event: HarnessTraceEvent): Promise<void> {
    if (event.event_type === 'model_request' && event.model_messages) {
      await this.writeSnapshot(
        `turn-${String(event.turn_index).padStart(2, '0')}-model-input.json`,
        event.model_messages,
      )
    }

    if (event.event_type === 'model_response' && event.response) {
      await this.writeSnapshot(
        `turn-${String(event.turn_index).padStart(2, '0')}-model-output.json`,
        {
          kind: 'model_output',
          mode: this.mode,
          response: event.response,
        },
      )
    }

    if (event.event_type === 'messages_updated' && event.messages) {
      await this.writeSnapshot(
        `turn-${String(event.turn_index).padStart(2, '0')}-transcript-after.json`,
        event.messages,
      )
    }
  }

  private async writeSnapshot(filename: string, value: unknown): Promise<void> {
    await writeFile(
      path.join(this.snapshotsDir, filename),
      `${JSON.stringify(redactTraceValue(value), null, 2)}\n`,
      'utf8',
    )
  }
}

function printConciseEvent(event: HarnessTraceEvent): void {
  if (event.event_type === 'model_request') {
    console.log(`[turn ${event.turn_index}] model request: ${event.message_count} messages`)
  } else if (event.event_type === 'tool_call_started') {
    console.log(`[turn ${event.turn_index}] tool call: ${event.tool_name}`)
  } else if (event.event_type === 'tool_call_completed' || event.event_type === 'tool_call_failed') {
    console.log(`[turn ${event.turn_index}] tool result: ${event.event_type === 'tool_call_failed' ? 'failed' : 'success'}, ${event.result_length ?? 0} chars`)
  } else if (event.event_type === 'turn_completed') {
    console.log(`[turn ${event.turn_index}] complete: reason=${event.termination_reason}`)
  } else if (event.event_type === 'run_completed') {
    console.log(`[complete] reason=${event.termination_reason}`)
  }
}

export async function readTraceEvents(tracePath: string): Promise<HarnessTraceEvent[]> {
  const content = await readFile(tracePath, 'utf8')
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as HarnessTraceEvent)
}
