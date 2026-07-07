import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AgentLoopObserver, AgentLoopTraceEvent, TraceMode } from '../src/debug/harness-trace.js'
import type { ToolDefinition } from '../src/tool.js'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'

type ScenarioName =
  | 'simple-answer'
  | 'read-file-success'
  | 'read-file-failure'
  | 'large-tool-result'
  | 'multi-tool-or-multi-turn'
  | 'compaction-observation'

type CliOptions = {
  scenario?: string
  traceMode: TraceMode
  output?: string
  maxTurns: number
  listScenarios: boolean
  printEvents: boolean
  overwrite: boolean
}

type ScenarioRun = {
  userInputs: string[]
  initialMessages?: ChatMessage[]
  model?: ModelAdapter
  beforeRun?: (outputDir: string) => Promise<void>
  notes?: string[]
}

const SCENARIOS: ScenarioName[] = [
  'simple-answer',
  'read-file-success',
  'read-file-failure',
  'large-tool-result',
  'multi-tool-or-multi-turn',
  'compaction-observation',
]

function usage(): string {
  return [
    'Usage: npm run debug:harness -- --scenario <name> --output <dir> [options]',
    '',
    'Options:',
    '  --list-scenarios',
    '  --scenario <name>',
    '  --trace-mode summary|full',
    '  --output <directory>',
    '  --max-turns <number>',
    '  --print-events',
    '  --overwrite',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    traceMode: 'summary',
    maxTurns: 8,
    listScenarios: false,
    printEvents: false,
    overwrite: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list-scenarios') {
      options.listScenarios = true
    } else if (arg === '--print-events') {
      options.printEvents = true
    } else if (arg === '--overwrite') {
      options.overwrite = true
    } else if (arg === '--scenario') {
      options.scenario = argv[++i]
    } else if (arg === '--trace-mode') {
      options.traceMode = argv[++i] as TraceMode
    } else if (arg === '--output') {
      options.output = argv[++i]
    } else if (arg === '--max-turns') {
      options.maxTurns = Number(argv[++i])
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.traceMode !== 'summary' && options.traceMode !== 'full') {
    throw new Error(`Invalid trace mode: ${options.traceMode}`)
  }
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error(`Invalid max turns: ${options.maxTurns}`)
  }
  return options
}

function isScenarioName(value: string | undefined): value is ScenarioName {
  return SCENARIOS.includes(value as ScenarioName)
}

function createSummaryAwareMockModel(): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      const lastUser = [...messages].reverse().find(message => message.role === 'user')
      if (lastUser?.role === 'user' && lastUser.content.includes('<summary>')) {
        return {
          type: 'assistant',
          content: '<summary>Older offline trace fixture messages were compacted for observation.</summary>',
        }
      }

      const { MockModelAdapter } = await import('../src/mock-model.js')
      return new MockModelAdapter().next(messages)
    },
  }
}

function createLargeFixtureModel(): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      const lastTool = [...messages].reverse().find(message => message.role === 'tool_result')
      if (lastTool?.role === 'tool_result') {
        return {
          type: 'assistant',
          content: `大型工具结果已返回，模型可见内容长度：${lastTool.content.length}`,
        }
      }
      return {
        type: 'tool_calls',
        calls: [{
          id: `large-${Date.now()}`,
          toolName: 'large_fixture',
          input: { name: 'offline-large-result' },
        }],
      }
    },
  }
}

function createLargeFixtureTool(): ToolDefinition<{ name: string }> {
  return {
    name: 'large_fixture',
    description: 'Return a deterministic large offline fixture for trace debugging.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    schema: z.object({ name: z.string() }),
    async run(input) {
      const header = `fixture=${input.name}\n`
      return {
        ok: true,
        output: header + 'L'.repeat(60_000),
      }
    },
  }
}

function makeCompactionMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Offline compaction observation fixture.' },
  ]
  for (let i = 0; i < 70; i++) {
    messages.push({
      id: `fixture-user-${i}`,
      role: 'user',
      content: `Historical request ${i}: ${'x'.repeat(5000)}`,
    })
    messages.push({
      id: `fixture-assistant-${i}`,
      role: 'assistant',
      content: `Historical answer ${i}: ${'y'.repeat(5000)}`,
    })
  }
  return messages
}

function buildScenario(name: ScenarioName): ScenarioRun {
  if (name === 'simple-answer') {
    return { userInputs: ['请用一句话说明 MiniCode 是什么。'] }
  }
  if (name === 'read-file-success') {
    return { userInputs: ['/read package.json'] }
  }
  if (name === 'read-file-failure') {
    return { userInputs: ['/read __trace_fixture_missing__.txt'] }
  }
  if (name === 'large-tool-result') {
    return {
      userInputs: ['生成大型离线工具结果'],
      model: createLargeFixtureModel(),
      notes: ['read_file has a 20k chunk limit, so this scenario uses a dedicated offline fixture tool to trigger replacement deterministically.'],
    }
  }
  if (name === 'multi-tool-or-multi-turn') {
    return {
      userInputs: ['/read package.json', '/ls src'],
      notes: ['MockModelAdapter does not emit multiple tool calls in one response; this scenario runs two deterministic agent turns in one trace.'],
    }
  }
  return {
    userInputs: ['请总结当前离线压缩观察状态。'],
    initialMessages: makeCompactionMessages(),
    model: createSummaryAwareMockModel(),
    notes: ['This scenario uses large synthetic prior messages to observe compaction checks and any stable compaction path without changing production thresholds.'],
  }
}

class OffsetObserver implements AgentLoopObserver {
  private offset = 0
  private lastSeenTurn = 0

  constructor(private readonly inner: AgentLoopObserver) {}

  async onEvent(event: AgentLoopTraceEvent): Promise<void> {
    const nextEvent = {
      ...event,
      turn_index: event.turn_index + this.offset,
    }
    this.lastSeenTurn = Math.max(this.lastSeenTurn, nextEvent.turn_index)
    await this.inner.onEvent(nextEvent)
  }

  advance(): void {
    this.offset = this.lastSeenTurn
  }
}

async function ensureOutputDir(outputDir: string, overwrite: boolean): Promise<void> {
  try {
    await stat(outputDir)
    if (!overwrite) {
      throw new Error(`Output directory already exists: ${outputDir}. Use --overwrite to replace trace files.`)
    }
    await rm(outputDir, { recursive: true, force: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      throw error
    }
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.listScenarios) {
    console.log(SCENARIOS.join('\n'))
    return
  }

  if (!isScenarioName(options.scenario)) {
    throw new Error(`Unknown or missing scenario: ${options.scenario ?? '(missing)'}\n\n${usage()}`)
  }
  if (!options.output) {
    throw new Error(`Missing --output\n\n${usage()}`)
  }

  const outputDir = path.resolve(options.output)
  await ensureOutputDir(outputDir, options.overwrite)
  process.env.MINI_CODE_MODEL_MODE = 'mock'
  process.env.MINI_CODE_HOME = path.join(outputDir, '.mini-code-home')

  const [
    { runAgentTurn },
    { HarnessTraceRecorder },
    { MockModelAdapter },
    { ToolRegistry },
    { readFileTool },
    { listFilesTool },
  ] = await Promise.all([
    import('../src/agent-loop.js'),
    import('../src/debug/harness-trace.js'),
    import('../src/mock-model.js'),
    import('../src/tool.js'),
    import('../src/tools/read-file.js'),
    import('../src/tools/list-files.js'),
  ])

  const scenario = buildScenario(options.scenario)
  const recorder = new HarnessTraceRecorder({
    outputDir,
    scenario: options.scenario,
    modelName: 'deepseek-chat',
    mode: options.traceMode,
    printEvents: options.printEvents,
  })
  await recorder.init()

  const observer = new OffsetObserver(recorder)
  const tools = new ToolRegistry([
    readFileTool,
    listFilesTool,
    createLargeFixtureTool(),
  ])
  let messages: ChatMessage[] = [
    ...(scenario.initialMessages ?? [
      { role: 'system', content: 'You are MiniCode running in an offline trace harness.' },
    ]),
  ]
  const model = scenario.model ?? new MockModelAdapter()

  await recorder.record({
    event_type: 'run_started',
    turn_index: 0,
    scenario: options.scenario,
    model_name: 'mock',
    trace_mode: options.traceMode,
    notes: scenario.notes ?? [],
  })

  try {
    for (const userInput of scenario.userInputs.slice(0, options.maxTurns)) {
      messages = [
        ...messages,
        { role: 'user', content: userInput },
      ]
      messages = await runAgentTurn({
        model,
        tools,
        messages,
        cwd: process.cwd(),
        maxSteps: options.maxTurns,
        modelName: 'deepseek-chat',
        observer,
      })
      observer.advance()
    }

    await recorder.record({
      event_type: 'run_completed',
      turn_index: observerTurnIndex(observer),
      termination_reason: 'scenario_completed',
      message_count: messages.length,
      message_roles: messages.map(message => message.role),
      messages,
    })
  } catch (error) {
    await recorder.record({
      event_type: 'run_failed',
      turn_index: observerTurnIndex(observer),
      error_type: error instanceof Error ? error.name : 'Error',
      error_message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await writeFile(
      path.join(outputDir, 'scenario.json'),
      `${JSON.stringify({
        scenario: options.scenario,
        trace_mode: options.traceMode,
        user_inputs: scenario.userInputs,
        notes: scenario.notes ?? [],
      }, null, 2)}\n`,
      'utf8',
    )
    await recorder.close()
  }

  console.log(`Trace written to ${outputDir}`)
}

function observerTurnIndex(observer: OffsetObserver): number {
  return Number((observer as unknown as { lastSeenTurn?: number }).lastSeenTurn ?? 0)
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
