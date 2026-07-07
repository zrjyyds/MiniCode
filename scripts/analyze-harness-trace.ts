import { readFile } from 'node:fs/promises'
import type { HarnessTraceEvent } from '../src/debug/harness-trace.js'

function usage(): string {
  return 'Usage: npm run analyze:harness-trace -- --input <trace.jsonl>'
}

function parseInput(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') {
      return argv[i + 1] ?? ''
    }
  }
  return ''
}

function numberField(event: HarnessTraceEvent, key: string): number {
  const value = event[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function readEvents(tracePath: string): Promise<HarnessTraceEvent[]> {
  const content = await readFile(tracePath, 'utf8')
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as HarnessTraceEvent)
}

function durationMs(events: HarnessTraceEvent[]): number {
  const first = events[0]?.timestamp
  const last = events.at(-1)?.timestamp
  if (!first || !last) return 0
  return Math.max(0, Date.parse(last) - Date.parse(first))
}

async function run(): Promise<void> {
  const input = parseInput(process.argv.slice(2))
  if (!input) {
    throw new Error(usage())
  }

  const events = await readEvents(input)
  const turns = new Set(events.filter(event => event.turn_index > 0).map(event => event.turn_index))
  const toolEvents = events.filter(event =>
    event.event_type === 'tool_call_completed' || event.event_type === 'tool_call_failed')
  const permissionEvents = events.filter(event => event.event_type === 'permission_decision')
  const compactionChecks = events.filter(event => event.event_type === 'compaction_checked')
  const compactionApplied = events.filter(event => event.event_type === 'compaction_applied')
  const messageCounts = events
    .map(event => numberField(event, 'message_count'))
    .filter(value => value > 0)
  const replacements = events.filter(event => event.event_type === 'tool_result_replaced')
  const termination = [...events].reverse().find(event =>
    event.event_type === 'turn_completed' || event.event_type === 'run_completed')

  const lines = [
    `总事件数: ${events.length}`,
    `总Turn数: ${turns.size}`,
    `模型调用次数: ${events.filter(event => event.event_type === 'model_request').length}`,
    `工具调用次数: ${events.filter(event => event.event_type === 'tool_call_started').length}`,
    `工具成功数: ${toolEvents.filter(event => event.event_type === 'tool_call_completed').length}`,
    `工具失败数: ${toolEvents.filter(event => event.event_type === 'tool_call_failed').length}`,
    `权限请求数: ${permissionEvents.filter(event => event.decision === 'requested').length}`,
    `压缩检查次数: ${compactionChecks.length}`,
    `压缩执行次数: ${compactionApplied.length}`,
    `消息最大数量: ${messageCounts.length > 0 ? Math.max(...messageCounts) : 0}`,
    `Tool Result总字符数: ${toolEvents.reduce((sum, event) => sum + numberField(event, 'result_length'), 0)}`,
    `Tool Result外部落盘次数: ${replacements.length}`,
    `总耗时: ${durationMs(events)} ms`,
    `终止原因: ${String(termination?.termination_reason ?? 'unknown')}`,
    `模型调用耗时: ${events
      .filter(event => event.event_type === 'model_response')
      .reduce((sum, event) => sum + numberField(event, 'duration_ms'), 0)} ms`,
    `工具执行耗时: ${toolEvents.reduce((sum, event) => sum + numberField(event, 'duration_ms'), 0)} ms`,
  ]

  console.log(lines.join('\n'))
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
