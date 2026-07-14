import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runAgentTurn } from '../agent-loop.js'
import { buildSystemPrompt } from '../prompt.js'
import { PermissionManager } from '../permissions.js'
import type { RuntimeConfig } from '../config.js'
import { createRealAgentAdapter } from '../real-agent/adapters.js'
import {
  canProbeRealProvider,
  loadRealAgentConfig,
  resolveRealAgentConfig,
} from '../real-agent/index.js'
import { saveSession, loadSession } from '../session.js'
import { createDefaultToolRegistry, hydrateMcpTools } from '../tools/index.js'
import type { ChatMessage } from '../types.js'
import { HarnessTraceRecorder } from '../debug/harness-trace.js'
import { createAcceptanceWorkspace } from './acceptance-workspace.js'

export type AgentLiveCaseId =
  | 'text-response'
  | 'read-file'
  | 'read-multiple-files'
  | 'modify-file-with-approval'
  | 'run-test-command'
  | 'fix-code-and-test'
  | 'load-skill'
  | 'call-local-mcp'
  | 'session-resume'
  | 'tool-failure-recovery'

export type AgentLiveRunResult = {
  caseId: AgentLiveCaseId
  status: 'passed' | 'failed' | 'skipped'
  requests: number
  toolCalls: number
  errorCode?: string
  errorMessage?: string
  traceDir?: string
}

export type AgentLiveSummary = {
  schemaVersion: '1.0'
  runId: string
  startedAt: string
  completedAt: string
  dryRun: boolean
  providerProtocol: string
  model: string
  results: AgentLiveRunResult[]
  metrics: {
    cases: number
    passed: number
    failed: number
    skipped: number
    requests: number
    toolCalls: number
  }
}

export type AgentLiveOptions = {
  configPath: string
  outputDir: string
  caseIds?: AgentLiveCaseId[]
  all?: boolean
  dryRun?: boolean
  noSaveRaw?: boolean
  maxRequests: number
  maxToolCalls: number
  timeoutMs: number
}

const CASES: Array<{ id: AgentLiveCaseId; prompt: string; maxSteps: number }> = [
  { id: 'text-response', prompt: 'Only reply: MINICODE_REAL_MODEL_OK', maxSteps: 2 },
  { id: 'read-file', prompt: 'Please read README.md and tell me the first line. You must use the file reading tool.', maxSteps: 4 },
  { id: 'read-multiple-files', prompt: 'Read README.md and src/calculator.js, then summarize both.', maxSteps: 6 },
  { id: 'modify-file-with-approval', prompt: 'Inspect src/calculator.js and tests/calculator.test.js, fix add so tests pass, and use a reviewed file modification.', maxSteps: 8 },
  { id: 'run-test-command', prompt: 'Run npm test and report whether the calculator module passes.', maxSteps: 6 },
  { id: 'fix-code-and-test', prompt: 'Find the calculator bug, fix it, run tests, and summarize the result.', maxSteps: 10 },
  { id: 'load-skill', prompt: 'Load the project-verification skill and follow it for this project.', maxSteps: 8 },
  { id: 'call-local-mcp', prompt: 'Use the local MCP tool count_workspace_files and report the count.', maxSteps: 6 },
  { id: 'session-resume', prompt: 'Read README.md and calculator.js, summarize current project state, but do not modify files.', maxSteps: 5 },
  { id: 'tool-failure-recovery', prompt: 'Try to read missing-file.txt, recover from the error by reading README.md, and explain what happened.', maxSteps: 6 },
]

function selectedCases(options: AgentLiveOptions): typeof CASES {
  if (options.all || !options.caseIds?.length) return CASES
  return CASES.filter(testCase => options.caseIds?.includes(testCase.id))
}

function metrics(results: AgentLiveRunResult[]): AgentLiveSummary['metrics'] {
  return {
    cases: results.length,
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    requests: results.reduce((sum, result) => sum + result.requests, 0),
    toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
  }
}

function renderMarkdown(summary: AgentLiveSummary): string {
  return [
    '# Live Agent Evaluation',
    '',
    `- Dry Run: ${summary.dryRun}`,
    `- Provider协议: ${summary.providerProtocol}`,
    `- Model: ${summary.model}`,
    `- Requests: ${summary.metrics.requests}`,
    `- Tool Calls: ${summary.metrics.toolCalls}`,
    '',
    '| Case | Status | Requests | Tool Calls | Error |',
    '|---|---|---:|---:|---|',
    ...summary.results.map(result => `| ${result.caseId} | ${result.status} | ${result.requests} | ${result.toolCalls} | ${result.errorCode ?? ''} |`),
    '',
  ].join('\n')
}

export function createAcceptanceMcpServers(args: {
  mcpServerScript: string
  workspace: string
}): RuntimeConfig['mcpServers'] {
  const scriptPath = path.resolve(args.mcpServerScript)
  return {
    acceptance: {
      command: process.execPath,
      args: ['--import', 'tsx', scriptPath, args.workspace],
      cwd: path.dirname(path.dirname(scriptPath)),
      protocol: 'content-length' as const,
    },
  }
}

function agentLiveError(code: string, message: string): Error {
  const error = new Error(message)
  error.name = code
  return error
}

export function assertAcceptanceMcpReady(tools: Awaited<ReturnType<typeof createDefaultToolRegistry>>): void {
  const server = tools.getMcpServers().find(entry => entry.name === 'acceptance')
  if (!server || server.status !== 'connected') {
    throw agentLiveError(
      'MCP_ACCEPTANCE_SERVER_UNAVAILABLE',
      `Acceptance MCP server is not connected${server?.error ? `: ${server.error}` : '.'}`,
    )
  }

  const requiredTools = [
    'mcp__acceptance__get_project_summary',
    'mcp__acceptance__count_workspace_files',
  ]
  const missing = requiredTools.find(name => !tools.find(name))
  if (missing) {
    throw agentLiveError(
      'MCP_ACCEPTANCE_TOOL_MISSING',
      `Acceptance MCP tool is not registered: ${missing}`,
    )
  }
}

async function runOneCase(args: {
  testCase: (typeof CASES)[number]
  realConfig: ReturnType<typeof resolveRealAgentConfig>
  outputDir: string
  mcpServerScript: string
}): Promise<AgentLiveRunResult> {
  const caseOutput = path.join(args.outputDir, args.testCase.id)
  const workspace = await createAcceptanceWorkspace(path.join(caseOutput, 'acceptance-workspace'))
  const mcpServers: RuntimeConfig['mcpServers'] =
    args.testCase.id === 'call-local-mcp'
      ? createAcceptanceMcpServers({
          mcpServerScript: args.mcpServerScript,
          workspace,
        })
      : {}
  const runtime: RuntimeConfig = {
    model: args.realConfig.model,
    baseUrl: args.realConfig.baseUrl,
    apiKey: args.realConfig.apiKey,
    maxOutputTokens: args.realConfig.maxOutputTokens,
    sourceSummary: `real-agent config: ${args.realConfig.sourcePath}`,
    mcpServers,
  }
  const tools = await createDefaultToolRegistry({ cwd: workspace, runtime })
  try {
    await hydrateMcpTools({ cwd: workspace, runtime, tools })
    if (args.testCase.id === 'call-local-mcp') {
      assertAcceptanceMcpReady(tools)
    }
  } catch (error) {
    await tools.dispose().catch(() => {})
    return {
      caseId: args.testCase.id,
      status: 'failed',
      requests: 0,
      toolCalls: 0,
      errorCode: error instanceof Error ? error.name : 'AGENT_LIVE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
  const permissions = new PermissionManager(workspace, async () => ({ decision: 'allow_once' }))
  await permissions.whenReady()
  const model = createRealAgentAdapter({ config: args.realConfig, tools })
  const trace = new HarnessTraceRecorder({
    outputDir: path.join(caseOutput, 'trace'),
    scenario: args.testCase.id,
    modelName: args.realConfig.model,
    mode: 'summary',
  })
  await trace.init()
  let messages: ChatMessage[] = [{
    role: 'system',
    content: await buildSystemPrompt(workspace, permissions.getSummary(), {
      skills: tools.getSkills(),
      mcpServers: tools.getMcpServers(),
    }),
  }, {
    role: 'user',
    content: args.testCase.prompt,
  }]

  let savedSessionId: string | undefined
  try {
    permissions.beginTurn()
    messages = await runAgentTurn({
      model,
      tools,
      messages,
      cwd: workspace,
      permissions,
      maxSteps: args.testCase.maxSteps,
      modelName: args.realConfig.model,
      observer: trace,
    })
    permissions.endTurn()

    if (args.testCase.id === 'session-resume') {
      savedSessionId = `phase8-${randomUUID().slice(0, 8)}`
      await saveSession(workspace, savedSessionId, messages)
      const restored = await loadSession(workspace, savedSessionId)
      messages = [
        messages[0]!,
        ...(restored ?? []),
        { role: 'user', content: 'Continue the previous task. Now fix the issue and run tests.' },
      ]
      permissions.beginTurn()
      messages = await runAgentTurn({
        model,
        tools,
        messages,
        cwd: workspace,
        permissions,
        maxSteps: 8,
        modelName: args.realConfig.model,
        observer: trace,
      })
      permissions.endTurn()
    }

    await trace.record({ event_type: 'run_completed', turn_index: 0, termination_reason: 'case_completed' })
    await trace.close()
    await tools.dispose()
    const toolCalls = messages.filter(message => message.role === 'assistant_tool_call').length
    return {
      caseId: args.testCase.id,
      status: 'passed',
      requests: messages.filter(message => message.role === 'assistant' || message.role === 'assistant_tool_call').length,
      toolCalls,
      traceDir: path.join(caseOutput, 'trace'),
    }
  } catch (error) {
    await trace.record({
      event_type: 'run_failed',
      turn_index: 0,
      error_message: error instanceof Error ? error.message : String(error),
      saved_session_id: savedSessionId,
    }).catch(() => {})
    await trace.close().catch(() => {})
    await tools.dispose().catch(() => {})
    return {
      caseId: args.testCase.id,
      status: 'failed',
      requests: messages.filter(message => message.role === 'assistant' || message.role === 'assistant_tool_call').length,
      toolCalls: messages.filter(message => message.role === 'assistant_tool_call').length,
      errorCode: error instanceof Error ? error.name : 'AGENT_LIVE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
      traceDir: path.join(caseOutput, 'trace'),
    }
  }
}

export async function runAgentLiveEvaluation(options: AgentLiveOptions): Promise<AgentLiveSummary> {
  const startedAt = new Date().toISOString()
  await mkdir(options.outputDir, { recursive: true })
  const rawConfig = await loadRealAgentConfig(options.configPath)
  const cases = selectedCases(options)
  const results: AgentLiveRunResult[] = []
  const environmentAvailable = canProbeRealProvider(rawConfig)
  const model = process.env[rawConfig.modelEnv] ?? '(missing)'
  const providerProtocol = rawConfig.protocol ?? 'auto'

  if (options.dryRun || !environmentAvailable) {
    for (const testCase of cases) {
      results.push({
        caseId: testCase.id,
        status: 'skipped',
        requests: 0,
        toolCalls: 0,
        errorCode: options.dryRun ? 'DRY_RUN' : 'LIVE_ENVIRONMENT_UNAVAILABLE',
      })
    }
  } else {
    const realConfig = resolveRealAgentConfig(rawConfig, options.configPath)
    const mcpServerScript = path.resolve('scripts', 'test-mcp-server.ts')
    let usedRequests = 0
    let usedToolCalls = 0
    for (const testCase of cases) {
      if (usedRequests >= options.maxRequests || usedToolCalls >= options.maxToolCalls) {
        results.push({
          caseId: testCase.id,
          status: 'skipped',
          requests: 0,
          toolCalls: 0,
          errorCode: 'LIVE_AGENT_BUDGET_EXCEEDED',
        })
        continue
      }
      const result = await runOneCase({ testCase, realConfig, outputDir: options.outputDir, mcpServerScript })
      usedRequests += result.requests
      usedToolCalls += result.toolCalls
      results.push(result)
      if (result.status === 'failed' && ['text-response', 'read-file', 'fix-code-and-test'].includes(result.caseId)) {
        break
      }
    }
  }

  const summary: AgentLiveSummary = {
    schemaVersion: '1.0',
    runId: randomUUID(),
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    providerProtocol,
    model,
    results,
    metrics: metrics(results),
  }
  await writeFile(path.join(options.outputDir, 'agent-live-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writeFile(path.join(options.outputDir, 'LIVE_AGENT_EVALUATION.md'), renderMarkdown(summary), 'utf8')
  return summary
}
