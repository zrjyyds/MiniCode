import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { z } from 'zod'
import { runAgentTurn } from '../agent-loop.js'
import { HarnessTraceRecorder, readTraceEvents } from '../debug/harness-trace.js'
import { MockModelAdapter } from '../mock-model.js'
import { ToolRegistry, type ToolDefinition } from '../tool.js'
import { listFilesTool } from '../tools/list-files.js'
import { readFileTool } from '../tools/read-file.js'
import type { AgentStep, ChatMessage, ModelAdapter } from '../types.js'
import { validateEvalCases } from './schema.js'
import { DEFAULT_EVAL_CASES, listEvalCases } from './cases.js'
import { evaluateTrace, firstFailureStage } from './evaluators.js'
import type {
  AgentEvalCase,
  AgentEvalResult,
  EvaluationSummary,
} from './types.js'
import { EVAL_SCHEMA_VERSION } from './types.js'

export type EvaluationRunOptions = {
  outputDir: string
  cases?: AgentEvalCase[]
  caseId?: string
  category?: string
  tag?: string
  failFast?: boolean
  savePassedTraces?: boolean
  keepFixtures?: boolean
  injectFailure?: string
  baseline?: Record<string, unknown>
}

type CaseRuntime = {
  model: ModelAdapter
  tools: ToolRegistry
  initialMessages: ChatMessage[]
  observerFault?: boolean
}

type BadcaseInput = {
  evalCase: AgentEvalCase
  result: AgentEvalResult
  caseOutputDir: string
  evaluationRunId: string
}

function largeFixtureTool(): ToolDefinition<{ name: string }> {
  return {
    name: 'large_fixture',
    description: 'Return a deterministic large evaluation fixture.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    schema: z.object({ name: z.string() }),
    async run(input) {
      return {
        ok: true,
        output: `fixture=${input.name}\n${'L'.repeat(60_000)}`,
      }
    },
  }
}

function makeLongConversation(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Offline evaluation compaction fixture.' },
  ]
  for (let i = 0; i < 70; i++) {
    messages.push({
      id: `eval-user-${i}`,
      role: 'user',
      content: `Historical request ${i}: ${'x'.repeat(5000)}`,
    })
    messages.push({
      id: `eval-assistant-${i}`,
      role: 'assistant',
      content: `Historical answer ${i}: ${'y'.repeat(5000)}`,
    })
  }
  return messages
}

function modelForCase(evalCase: AgentEvalCase): ModelAdapter {
  if (evalCase.setup?.kind === 'invalid-tool-arguments') {
    return {
      async next(messages): Promise<AgentStep> {
        if (messages.some(message => message.role === 'tool_result')) {
          return { type: 'assistant', content: '工具参数校验失败已返回模型。' }
        }
        return {
          type: 'tool_calls',
          calls: [{ id: 'invalid-args-call', toolName: 'read_file', input: { path: 123 } }],
        }
      },
    }
  }
  if (evalCase.setup?.kind === 'forbidden-tool') {
    return {
      async next(messages): Promise<AgentStep> {
        if (messages.some(message => message.role === 'tool_result')) {
          return { type: 'assistant', content: '禁止工具未执行，错误已返回。' }
        }
        return {
          type: 'tool_calls',
          calls: [{ id: 'forbidden-tool-call', toolName: 'delete_everything', input: {} }],
        }
      },
    }
  }
  if (evalCase.setup?.kind === 'large-tool-result') {
    return {
      async next(messages): Promise<AgentStep> {
        const lastTool = [...messages].reverse().find(message => message.role === 'tool_result')
        if (lastTool?.role === 'tool_result') {
          return { type: 'assistant', content: `大型工具结果已返回，模型可见内容长度：${lastTool.content.length}` }
        }
        return {
          type: 'tool_calls',
          calls: [{ id: 'large-eval-call', toolName: 'large_fixture', input: { name: 'eval-large-result' } }],
        }
      },
    }
  }
  if (evalCase.setup?.kind === 'max-turn') {
    return {
      async next(): Promise<AgentStep> {
        return {
          type: 'tool_calls',
          calls: [{ id: `loop-${Date.now()}`, toolName: 'list_files', input: { path: 'src' } }],
        }
      },
    }
  }
  if (evalCase.setup?.kind === 'long-conversation') {
    return {
      async next(messages): Promise<AgentStep> {
        const lastUser = [...messages].reverse().find(message => message.role === 'user')
        if (lastUser?.role === 'user' && lastUser.content.includes('<summary>')) {
          return { type: 'assistant', content: '<summary>Older evaluation context was compacted.</summary>' }
        }
        return new MockModelAdapter().next(messages)
      },
    }
  }
  return new MockModelAdapter()
}

function runtimeForCase(evalCase: AgentEvalCase): CaseRuntime {
  return {
    model: modelForCase(evalCase),
    tools: new ToolRegistry([readFileTool, listFilesTool, largeFixtureTool()]),
    initialMessages: evalCase.setup?.kind === 'long-conversation'
      ? makeLongConversation()
      : [{ role: 'system', content: 'You are MiniCode running in an offline evaluation harness.' }],
    observerFault: evalCase.setup?.kind === 'observer-failure',
  }
}

function filterCases(cases: AgentEvalCase[], options: EvaluationRunOptions): AgentEvalCase[] {
  return cases.filter(evalCase => {
    if (options.caseId && evalCase.id !== options.caseId) return false
    if (options.category && evalCase.category !== options.category) return false
    if (options.tag && !evalCase.tags.includes(options.tag)) return false
    return true
  })
}

function injectedCase(evalCase: AgentEvalCase, injectFailure?: string): AgentEvalCase {
  if (!injectFailure || evalCase.id !== 'read-file-success') return evalCase
  if (injectFailure === 'wrong-tool') {
    return {
      ...evalCase,
      expected: {
        ...evalCase.expected,
        expectedTools: [{ name: 'grep_files', status: 'success' }],
      },
    }
  }
  return evalCase
}

export async function runEvaluation(options: EvaluationRunOptions): Promise<EvaluationSummary> {
  const evaluationRunId = randomUUID()
  const startedAt = new Date().toISOString()
  await mkdir(options.outputDir, { recursive: true })

  const sourceCases = options.cases ?? listEvalCases()
  const schemaErrors = validateEvalCases(sourceCases)
  if (schemaErrors.length > 0) {
    throw new Error(`Invalid eval cases:\n${schemaErrors.join('\n')}`)
  }

  const selectedCases = filterCases(sourceCases, options)
  const results: AgentEvalResult[] = []
  for (const baseCase of selectedCases) {
    const evalCase = injectedCase(baseCase, options.injectFailure)
    const result = await runSingleCase(evalCase, {
      ...options,
      outputDir: path.join(options.outputDir, 'cases', evalCase.id),
    }, evaluationRunId)
    results.push(result)
    if (options.failFast && result.status !== 'passed') break
  }

  const completedAt = new Date().toISOString()
  const summary: EvaluationSummary = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    evaluationRunId,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    results,
    metrics: calculateAggregateMetrics(results),
    baseline: options.baseline,
  }
  await writeEvaluationOutputs(options.outputDir, summary)
  return summary
}

async function runSingleCase(
  evalCase: AgentEvalCase,
  options: EvaluationRunOptions,
  evaluationRunId: string,
): Promise<AgentEvalResult> {
  const startedAt = new Date().toISOString()
  const caseOutputDir = options.outputDir
  await rm(caseOutputDir, { recursive: true, force: true })
  await mkdir(caseOutputDir, { recursive: true })

  const runtime = runtimeForCase(evalCase)
  const recorder = new HarnessTraceRecorder({
    outputDir: caseOutputDir,
    scenario: evalCase.id,
    modelName: 'mock',
    mode: evalCase.input.traceMode ?? 'summary',
  })
  await recorder.init()

  const observer = runtime.observerFault
    ? { async onEvent(event: Parameters<typeof recorder.onEvent>[0]) { await recorder.onEvent(event); throw new Error('injected observer failure') } }
    : recorder
  let messages: ChatMessage[] = [
    ...runtime.initialMessages,
    { role: 'user', content: evalCase.input.userMessage },
  ]

  await recorder.record({
    event_type: 'run_started',
    turn_index: 0,
    scenario: evalCase.id,
    model_name: 'mock',
    trace_mode: evalCase.input.traceMode ?? 'summary',
  })

  let infrastructureError: Error | undefined
  try {
    messages = await runAgentTurn({
      model: runtime.model,
      tools: runtime.tools,
      messages,
      cwd: path.resolve(evalCase.input.workingDirectory ?? process.cwd()),
      maxSteps: evalCase.input.maxTurns ?? 6,
      modelName: 'deepseek-chat',
      observer,
    })
    await recorder.record({
      event_type: 'run_completed',
      turn_index: Math.max(1, Math.max(...messages.map(() => 1))),
      termination_reason: 'scenario_completed',
      message_count: messages.length,
      message_roles: messages.map(message => message.role),
      messages,
    })
  } catch (error) {
    infrastructureError = error instanceof Error ? error : new Error(String(error))
    await recorder.record({
      event_type: 'run_failed',
      turn_index: 0,
      error_type: infrastructureError.name,
      error_message: infrastructureError.message,
    })
  } finally {
    await recorder.close()
    await writeFile(
      path.join(caseOutputDir, 'input.json'),
      `${JSON.stringify({ case: evalCase, userMessage: evalCase.input.userMessage }, null, 2)}\n`,
      'utf8',
    )
  }

  const events = await readTraceEvents(recorder.jsonlPath)
  const { assertions, metrics } = evaluateTrace(evalCase, events)
  metrics.durationMs = Math.max(0, Date.now() - Date.parse(startedAt))
  const failedAssertions = assertions.filter(item => !item.passed)
  const observedFailureStage =
    evalCase.expected.expectedFailureStage ??
    firstFailureStage(assertions) ??
    (infrastructureError ? 'EVALUATION_INFRASTRUCTURE' : undefined)
  const status = infrastructureError
    ? 'error'
    : failedAssertions.length === 0
      ? 'passed'
      : 'failed'
  const completedAt = new Date().toISOString()
  const result: AgentEvalResult = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    evaluationRunId,
    caseId: evalCase.id,
    status,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    assertions,
    metrics,
    failureStage: failedAssertions.length > 0 ? firstFailureStage(assertions) : undefined,
    observedFailureStage,
    failureReasons: infrastructureError
      ? [infrastructureError.message]
      : failedAssertions.map(item => item.message),
    tracePath: recorder.jsonlPath,
    summaryPath: recorder.summaryPath,
  }

  await writeFile(
    path.join(caseOutputDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  if (status !== 'passed') {
    result.badcasePath = await saveBadcase({
      evalCase,
      result,
      caseOutputDir,
      evaluationRunId,
    })
  } else if (!options.savePassedTraces) {
    await rm(path.join(caseOutputDir, 'snapshots'), { recursive: true, force: true })
  }

  if (!options.keepFixtures) {
    await rm(path.join(caseOutputDir, '.mini-code-home'), { recursive: true, force: true })
  }

  return result
}

export function calculateAggregateMetrics(results: AgentEvalResult[]): Record<string, number> {
  const total = results.length
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const errors = results.filter(result => result.status === 'error').length
  const productResults = results.filter(result => result.status !== 'error')
  const denominator = Math.max(1, productResults.length)
  const sum = (selector: (result: AgentEvalResult) => number): number =>
    results.reduce((value, result) => value + selector(result), 0)
  const rate = (selector: (result: AgentEvalResult) => boolean, items = productResults): number =>
    items.length === 0 ? 0 : items.filter(selector).length / items.length

  return {
    case_count: total,
    passed_count: passed,
    failed_count: failed,
    error_count: errors,
    skipped_count: results.filter(result => result.status === 'skipped').length,
    pass_rate: total === 0 ? 0 : passed / total,
    task_success_rate: rate(result => result.metrics.taskSuccess),
    completion_rate: rate(result => result.metrics.completed),
    crash_rate: rate(result => result.metrics.crashed, results),
    timeout_rate: rate(result => result.metrics.timeout, results),
    trajectory_validity_rate: rate(result => result.metrics.trajectoryValid),
    expected_role_sequence_match_rate: rate(result => result.metrics.roleSequenceMatched || !result.assertions.some(item => item.id === 'roles.sequence')),
    termination_correctness_rate: rate(result => result.metrics.terminationCorrect || !result.assertions.some(item => item.id === 'termination.reason')),
    tool_selection_accuracy: rate(result => result.metrics.toolSelectionCorrect),
    tool_argument_accuracy: rate(result => result.metrics.toolArgumentCorrect),
    tool_success_rate: denominator === 0 ? 0 : sum(result => result.assertions.filter(item => item.id.endsWith('.status') && item.passed).length) / Math.max(1, sum(result => result.assertions.filter(item => item.id.endsWith('.status')).length)),
    unnecessary_tool_call_rate: rate(result => result.assertions.some(item => item.id === 'tool.call_count' && !item.passed)),
    tool_result_return_rate: rate(result => result.metrics.toolResultReturned),
    unauthorized_action_rate: total === 0 ? 0 : sum(result => result.metrics.unauthorizedActions) / total,
    path_escape_block_rate: rate(result => result.caseId === 'path-traversal-denied' ? result.status === 'passed' : true, results),
    secret_leakage_rate: total === 0 ? 0 : results.filter(result => result.metrics.secretLeakages > 0).length / total,
    forbidden_tool_execution_rate: total === 0 ? 0 : results.filter(result => result.metrics.forbiddenToolExecutions > 0).length / total,
    compaction_trigger_accuracy: rate(result => result.caseId === 'compaction-snip' ? result.metrics.compactionTriggered : true, results),
    compaction_completion_rate: rate(result => result.caseId === 'compaction-snip' ? result.metrics.compactionCompleted : true, results),
    context_reduction_ratio: Math.max(0, ...results.map(result => result.metrics.contextReductionRatio)),
    transcript_preservation_rate: rate(result => result.metrics.transcriptPreserved, results),
    average_turns: total === 0 ? 0 : sum(result => result.metrics.turns) / total,
    maximum_turns: Math.max(0, ...results.map(result => result.metrics.turns)),
    average_tool_calls: total === 0 ? 0 : sum(result => result.metrics.toolCalls) / total,
    evaluation_duration_ms: sum(result => result.durationMs),
    trace_parse_error_rate: total === 0 ? 0 : results.filter(result => result.metrics.traceParseErrors > 0).length / total,
    security_violation_count: sum(result => result.metrics.unauthorizedActions + result.metrics.secretLeakages + result.metrics.forbiddenToolExecutions),
  }
}

async function saveBadcase(input: BadcaseInput): Promise<string> {
  const badcaseId = `${input.evalCase.id}-${input.evaluationRunId}`
  const badcaseDir = path.join(path.dirname(path.dirname(input.caseOutputDir)), 'badcases', badcaseId)
  await rm(badcaseDir, { recursive: true, force: true })
  await mkdir(badcaseDir, { recursive: true })

  await cp(path.join(input.caseOutputDir, 'trace.jsonl'), path.join(badcaseDir, 'trace.jsonl'))
  await cp(path.join(input.caseOutputDir, 'trace-summary.md'), path.join(badcaseDir, 'trace-summary.md'))
  await writeFile(path.join(badcaseDir, 'assertions.json'), `${JSON.stringify(input.result.assertions, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'input.json'), `${JSON.stringify(input.evalCase, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'environment.json'), `${JSON.stringify({
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd_basename: path.basename(process.cwd()),
  }, null, 2)}\n`, 'utf8')

  const replayCommand = `npm run replay:badcase -- --input ${badcaseDir} --compare`
  const badcase = {
    schema_version: EVAL_SCHEMA_VERSION,
    badcase_id: badcaseId,
    case_id: input.evalCase.id,
    evaluation_run_id: input.evaluationRunId,
    created_at: new Date().toISOString(),
    git_commit: await gitCommit(),
    node_version: process.version,
    platform: process.platform,
    failure_stage: input.result.failureStage ?? input.result.observedFailureStage,
    failure_reasons: input.result.failureReasons,
    failed_assertions: input.result.assertions.filter(item => !item.passed),
    termination_reason: input.result.assertions.find(item => item.id === 'termination.reason')?.actual,
    trace_path: 'trace.jsonl',
    replay_command: replayCommand,
  }
  await writeFile(path.join(badcaseDir, 'badcase.json'), `${JSON.stringify(badcase, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'replay.json'), `${JSON.stringify({ case: input.evalCase, compare: true }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'README.md'), [
    `# Badcase ${badcaseId}`,
    '',
    `- Case: ${input.evalCase.id}`,
    `- Failure stage: ${badcase.failure_stage ?? 'unknown'}`,
    `- Replay: \`${replayCommand}\``,
    '',
  ].join('\n'), 'utf8')
  return badcaseDir
}

async function gitCommit(): Promise<string> {
  try {
    const { execFile } = await import('node:child_process')
    return await new Promise(resolve => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }, (error, stdout) => {
        resolve(error ? 'unknown' : stdout.trim())
      })
    })
  } catch {
    return 'unknown'
  }
}

async function writeEvaluationOutputs(outputDir: string, summary: EvaluationSummary): Promise<void> {
  await writeFile(path.join(outputDir, 'evaluation-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(outputDir, 'evaluation-results.jsonl'),
    summary.results.map(result => JSON.stringify(result)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(path.join(outputDir, 'evaluation-summary.csv'), renderCsv(summary), 'utf8')
  await writeFile(path.join(outputDir, 'evaluation-summary.md'), renderMarkdown(summary), 'utf8')
}

function renderCsv(summary: EvaluationSummary): string {
  return [
    'case_id,category,status,failure_stage,duration_ms',
    ...summary.results.map(result => {
      const evalCase = DEFAULT_EVAL_CASES.find(item => item.id === result.caseId)
      return [
        result.caseId,
        evalCase?.category ?? '',
        result.status,
        result.failureStage ?? result.observedFailureStage ?? '',
        result.durationMs,
      ].join(',')
    }),
  ].join('\n') + '\n'
}

function renderMarkdown(summary: EvaluationSummary): string {
  const total = summary.results.length
  const passed = summary.results.filter(result => result.status === 'passed').length
  const failed = summary.results.filter(result => result.status === 'failed').length
  const errors = summary.results.filter(result => result.status === 'error').length
  const skipped = summary.results.filter(result => result.status === 'skipped').length
  const failedAssertions = summary.results.flatMap(result =>
    result.assertions.filter(item => !item.passed).map(item => ({ result, item })))
  return [
    '# Agent Harness Evaluation Report',
    '',
    '## 总结',
    `- 总Case数: ${total}`,
    `- 通过: ${passed}`,
    `- 失败: ${failed}`,
    `- 错误: ${errors}`,
    `- 跳过: ${skipped}`,
    `- 通过率: ${total === 0 ? '0.00' : (passed / total).toFixed(2)}`,
    `- 总耗时: ${summary.durationMs} ms`,
    '',
    '## 核心指标',
    '| 指标 | 结果 |',
    '|---|---:|',
    ...Object.entries(summary.metrics).map(([key, value]) => `| ${key} | ${typeof value === 'number' ? value.toFixed(4) : value} |`),
    '',
    '## Case结果',
    '| Case | Category | Status | Failure Stage | Duration |',
    '|---|---|---|---|---:|',
    ...summary.results.map(result => {
      const evalCase = DEFAULT_EVAL_CASES.find(item => item.id === result.caseId)
      return `| ${result.caseId} | ${evalCase?.category ?? ''} | ${result.status} | ${result.failureStage ?? result.observedFailureStage ?? ''} | ${result.durationMs} |`
    }),
    '',
    '## 失败断言',
    '| Case | Assertion | Expected | Actual |',
    '|---|---|---|---|',
    ...(failedAssertions.length === 0
      ? ['| none | none | none | none |']
      : failedAssertions.map(({ result, item }) => `| ${result.caseId} | ${item.id} | ${JSON.stringify(item.expected)} | ${JSON.stringify(item.actual)} |`)),
    '',
    '## Badcase',
    '| Case | Badcase Path | Replay Command |',
    '|---|---|---|',
    ...summary.results
      .filter(result => result.badcasePath)
      .map(result => `| ${result.caseId} | ${result.badcasePath} | \`npm run replay:badcase -- --input ${result.badcasePath} --compare\` |`),
    ...(summary.results.some(result => result.badcasePath) ? [] : ['| none | none | none |']),
    '',
    '## 与基线对比',
    '| Metric | Baseline | Current | Delta |',
    '|---|---:|---:|---:|',
    ...Object.entries(summary.metrics).map(([key, value]) => {
      const baseline = typeof summary.baseline?.[key] === 'number' ? Number(summary.baseline[key]) : 0
      return `| ${key} | ${baseline.toFixed(4)} | ${value.toFixed(4)} | ${(value - baseline).toFixed(4)} |`
    }),
    '',
    '> Mock模型下的指标主要评价Harness逻辑，不代表真实大模型推理能力。',
    '',
  ].join('\n')
}

export async function loadBaseline(filepath?: string): Promise<Record<string, unknown> | undefined> {
  if (!filepath) return undefined
  return JSON.parse(await readFile(filepath, 'utf8')) as Record<string, unknown>
}

export function defaultOutputDir(): string {
  return path.join(os.tmpdir(), `minicode-eval-${Date.now()}`)
}
