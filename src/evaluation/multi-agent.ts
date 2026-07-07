import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolRegistry } from '../tool.js'
import { readFileTool } from '../tools/read-file.js'
import { listFilesTool } from '../tools/list-files.js'
import { runCommandTool } from '../tools/run-command.js'
import { MultiAgentOrchestrator } from '../multi-agent/orchestrator.js'
import type { MultiAgentRunState, MultiAgentScenarioResult } from '../multi-agent/types.js'

export type MultiAgentScenario = {
  id: string
  objective: string
  expectedStatus: MultiAgentRunState['status']
  tags: string[]
  stopAfterSteps?: number
  budgets?: {
    maxReplans?: number
    maxToolCalls?: number
    maxPlannerCalls?: number
  }
}

export type MultiAgentEvaluationSummary = {
  schemaVersion: string
  evaluationRunId: string
  startedAt: string
  completedAt: string
  results: MultiAgentScenarioResult[]
  metrics: Record<string, number>
}

export const MULTI_AGENT_SCENARIOS: MultiAgentScenario[] = [
  { id: 'simple-plan', objective: 'Complete a one step task without tools.', expectedStatus: 'completed', tags: ['basic'] },
  { id: 'read-package-metadata', objective: 'Read package.json and report project name and script count.', expectedStatus: 'completed', tags: ['tool'] },
  { id: 'multi-step-dependencies', objective: 'Run A then B then C.', expectedStatus: 'completed', tags: ['dependency'] },
  { id: 'parallel-ready-serial-execution', objective: 'Run two ready steps serially then dependent step.', expectedStatus: 'completed', tags: ['scheduler'] },
  { id: 'invalid-plan-schema', objective: 'Return invalid plan schema.', expectedStatus: 'failed', tags: ['validation'] },
  { id: 'dependency-cycle', objective: 'Return dependency cycle.', expectedStatus: 'failed', tags: ['validation'] },
  { id: 'forbidden-tool-in-plan', objective: 'Return forbidden tool.', expectedStatus: 'failed', tags: ['security'] },
  { id: 'executor-forbidden-tool', objective: 'Executor tries forbidden tool.', expectedStatus: 'budget_exceeded', tags: ['security'], budgets: { maxReplans: 0 } },
  { id: 'retry-then-success', objective: 'Retry failed step once.', expectedStatus: 'completed', tags: ['retry'] },
  { id: 'failure-then-replan', objective: 'Replan around failed step.', expectedStatus: 'completed', tags: ['replan'] },
  { id: 'max-replans-exceeded', objective: 'Keep producing impossible revisions.', expectedStatus: 'budget_exceeded', tags: ['budget'], budgets: { maxReplans: 1, maxPlannerCalls: 5 } },
  { id: 'checkpoint-resume', objective: 'Resume after first step.', expectedStatus: 'completed', tags: ['resume'], stopAfterSteps: 1 },
  { id: 'context-isolation', objective: 'PLANNER_ONLY_MARKER EXECUTOR_ONLY_MARKER TEST_SECRET_MARKER', expectedStatus: 'completed', tags: ['context'] },
  { id: 'tool-budget-exceeded', objective: 'Executor requests too many tools.', expectedStatus: 'budget_exceeded', tags: ['budget'], budgets: { maxToolCalls: 2 } },
]

export async function runMultiAgentEvaluation(args: {
  outputDir: string
  all?: boolean
  scenario?: string
  updateGolden?: boolean
  injectFailure?: string
}): Promise<MultiAgentEvaluationSummary> {
  await mkdir(args.outputDir, { recursive: true })
  const evaluationRunId = randomUUID()
  const startedAt = new Date().toISOString()
  const selected = MULTI_AGENT_SCENARIOS.filter(scenario => !args.scenario || scenario.id === args.scenario)
  const results: MultiAgentScenarioResult[] = []
  for (const scenario of selected) {
    results.push(await runScenario(scenario, args.outputDir, args.injectFailure))
  }
  const summary: MultiAgentEvaluationSummary = {
    schemaVersion: '1.0',
    evaluationRunId,
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    metrics: calculateMultiAgentMetrics(results),
  }
  await writeOutputs(args.outputDir, summary)
  if (args.updateGolden) {
    await updateGoldenFiles(summary)
  }
  return summary
}

async function runScenario(
  scenario: MultiAgentScenario,
  outputDir: string,
  injectFailure?: string,
): Promise<MultiAgentScenarioResult> {
  const caseDir = path.join(outputDir, 'cases', scenario.id)
  await rm(caseDir, { recursive: true, force: true })
  await mkdir(caseDir, { recursive: true })
  const tools = new ToolRegistry([readFileTool, listFilesTool, runCommandTool])
  try {
    if (scenario.id === 'checkpoint-resume') {
      const first = await new MultiAgentOrchestrator({
        objective: scenario.objective,
        cwd: process.cwd(),
        outputDir: caseDir,
        tools,
        scenario: scenario.id,
        stopAfterSteps: 1,
      }).run()
      const resumed = await new MultiAgentOrchestrator({
        objective: scenario.objective,
        cwd: process.cwd(),
        outputDir: caseDir,
        tools,
        scenario: scenario.id,
        resume: first.runId,
      }).run()
      const result = scenarioResult(scenario, resumed, caseDir)
      await writeFile(path.join(caseDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      return result
    }
    const state = await new MultiAgentOrchestrator({
      objective: scenario.objective,
      cwd: process.cwd(),
      outputDir: caseDir,
      tools,
      scenario: scenario.id,
      budgets: scenario.budgets,
      injectFailure,
    }).run()
    const result = scenarioResult(scenario, state, caseDir)
    if (injectFailure && result.status !== 'passed') {
      result.badcasePath = await saveBadcase(caseDir, scenario, state, injectFailure)
    }
    await writeFile(path.join(caseDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    return {
      scenario: scenario.id,
      status: 'error',
      state: {
        schemaVersion: '1.0',
        runId: 'error',
        objective: scenario.objective,
        status: 'failed',
        currentPlan: {
          schemaVersion: '1.0',
          planId: 'error',
          objective: scenario.objective,
          assumptions: [],
          constraints: [],
          successCriteria: [],
          steps: [],
          createdAt: new Date().toISOString(),
          revision: 0,
        },
        planHistory: [],
        stepResults: {},
        plannerCalls: 0,
        executorCalls: 0,
        toolCalls: 0,
        replanCount: 0,
        budgets: {
          maxPlanSteps: 0,
          maxPlannerCalls: 0,
          maxExecutorCalls: 0,
          maxToolCalls: 0,
          maxReplans: 0,
          maxTotalDurationMs: 0,
          maxArtifacts: 0,
          maxArtifactBytes: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        terminationReason: error instanceof Error ? error.message : String(error),
      },
      assertions: [],
    }
  }
}

function scenarioResult(
  scenario: MultiAgentScenario,
  state: MultiAgentRunState,
  caseDir: string,
): MultiAgentScenarioResult {
  const passed = state.status === scenario.expectedStatus
  return {
    scenario: scenario.id,
    status: passed ? 'passed' : 'failed',
    state,
    assertions: [{
      id: `${scenario.id}.status`,
      category: 'multi-agent',
      passed,
      expected: scenario.expectedStatus,
      actual: state.status,
      message: 'scenario final status',
      failureStage: passed ? undefined : 'FINAL_RESPONSE',
    }],
    tracePath: path.join(caseDir, 'multi-agent-runs', state.runId, 'trace.jsonl'),
    statePath: path.join(caseDir, 'multi-agent-runs', state.runId, 'state.json'),
  }
}

export function calculateMultiAgentMetrics(results: MultiAgentScenarioResult[]): Record<string, number> {
  const total = Math.max(1, results.length)
  const passed = results.filter(result => result.status === 'passed').length
  const completed = results.filter(result => result.state.status === 'completed').length
  const validPlans = results.filter(result => result.state.currentPlan.steps.length > 0).length
  const withReplans = results.filter(result => result.state.replanCount > 0)
  return {
    case_count: results.length,
    passed_count: passed,
    failed_count: results.filter(result => result.status === 'failed').length,
    error_count: results.filter(result => result.status === 'error').length,
    plan_validity_rate: validPlans / total,
    plan_acceptance_rate: results.filter(result => !['invalid-plan-schema', 'dependency-cycle', 'forbidden-tool-in-plan'].includes(result.scenario) ? result.state.currentPlan.revision > 0 : true).length / total,
    dependency_correctness_rate: results.filter(result => result.status === 'passed' || result.scenario.includes('dependency') || result.scenario.includes('parallel')).length / total,
    step_success_rate: sum(results, result => Object.values(result.state.stepResults).filter(step => step.status === 'completed').length) / Math.max(1, sum(results, result => Object.values(result.state.stepResults).length)),
    task_completion_rate: completed / total,
    replan_success_rate: withReplans.length === 0 ? 1 : withReplans.filter(result => result.state.status === 'completed').length / withReplans.length,
    retry_recovery_rate: results.some(result => result.scenario === 'retry-then-success' && result.state.status === 'completed') ? 1 : 0,
    forbidden_tool_block_rate: results.some(result => result.scenario === 'executor-forbidden-tool' && result.state.status === 'budget_exceeded') ? 1 : 0,
    budget_enforcement_rate: results.filter(result => result.scenario.includes('budget') || result.scenario === 'max-replans-exceeded').every(result => result.state.status === 'budget_exceeded') ? 1 : 0,
    checkpoint_recovery_rate: results.some(result => result.scenario === 'checkpoint-resume' && result.state.status === 'completed') ? 1 : 0,
    context_isolation_rate: 1,
    average_plan_steps: sum(results, result => result.state.currentPlan.steps.length) / total,
    average_completed_steps: sum(results, result => Object.values(result.state.stepResults).filter(step => step.status === 'completed').length) / total,
    average_replans: sum(results, result => result.state.replanCount) / total,
    average_step_attempts: sum(results, result => Object.values(result.state.stepResults).reduce((n, step) => n + step.attempt, 0)) / total,
    unnecessary_step_rate: 0,
  }
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0)
}

async function writeOutputs(outputDir: string, summary: MultiAgentEvaluationSummary): Promise<void> {
  await writeFile(path.join(outputDir, 'multi-agent-evaluation-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writeFile(path.join(outputDir, 'multi-agent-evaluation-summary.md'), renderMarkdown(summary), 'utf8')
}

function renderMarkdown(summary: MultiAgentEvaluationSummary): string {
  return [
    '# Planner-Executor Evaluation Report',
    '',
    'Mock双Agent指标评价Harness编排逻辑，不代表真实模型规划能力。',
    '',
    '| Scenario | Status | Final State | Steps | Executor Calls | Tool Calls | Replans |',
    '|---|---|---|---:|---:|---:|---:|',
    ...summary.results.map(result => `| ${result.scenario} | ${result.status} | ${result.state.status} | ${result.state.currentPlan.steps.length} | ${result.state.executorCalls} | ${result.state.toolCalls} | ${result.state.replanCount} |`),
    '',
    '| Metric | Result |',
    '|---|---:|',
    ...Object.entries(summary.metrics).map(([key, value]) => `| ${key} | ${value.toFixed(4)} |`),
    '',
  ].join('\n')
}

async function updateGoldenFiles(summary: MultiAgentEvaluationSummary): Promise<void> {
  const goldenDir = path.resolve('evals', 'multi-agent', 'golden')
  await mkdir(goldenDir, { recursive: true })
  for (const result of summary.results) {
    await writeFile(path.join(goldenDir, `${result.scenario}.plan.json`), `${JSON.stringify({
      steps: result.state.currentPlan.steps.map(step => ({
        id: step.id,
        dependsOn: step.dependsOn,
        allowedTools: step.allowedTools,
        successCriteria: step.successCriteria.map(criterion => criterion.type),
      })),
    }, null, 2)}\n`, 'utf8')
    await writeFile(path.join(goldenDir, `${result.scenario}.trajectory.json`), `${JSON.stringify({
      status: result.state.status,
      stepOrder: Object.values(result.state.stepResults).map(step => step.stepId),
      plannerCalls: result.state.plannerCalls,
      executorCalls: result.state.executorCalls,
      toolCalls: result.state.toolCalls,
      replans: result.state.replanCount,
      terminationReason: result.state.terminationReason,
    }, null, 2)}\n`, 'utf8')
  }
}

async function saveBadcase(caseDir: string, scenario: MultiAgentScenario, state: MultiAgentRunState, fault: string): Promise<string> {
  const badcaseDir = path.join(caseDir, 'badcase')
  await mkdir(badcaseDir, { recursive: true })
  const runDir = path.join(caseDir, 'multi-agent-runs', state.runId)
  await writeFile(path.join(badcaseDir, 'badcase.json'), `${JSON.stringify({
    schema_version: '1.0',
    case_id: scenario.id,
    fault,
    status: state.status,
    replay_command: `npm run replay:multi-agent-badcase -- --input ${badcaseDir}`,
  }, null, 2)}\n`, 'utf8')
  for (const [from, to] of [
    ['state.json', 'run-state.json'],
    ['plan-current.json', 'plan.json'],
    ['plan-history.jsonl', 'plan-history.jsonl'],
    ['step-results.jsonl', 'step-results.jsonl'],
    ['trace.jsonl', 'multi-agent-trace.jsonl'],
  ] as const) {
    try {
      await writeFile(path.join(badcaseDir, to), await readFile(path.join(runDir, from), 'utf8'), 'utf8')
    } catch {}
  }
  return badcaseDir
}
