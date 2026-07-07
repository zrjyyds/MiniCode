import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, type ToolDefinition } from '../src/tool.js'
import { PlanValidator } from '../src/multi-agent/plan-validator.js'
import { StepScheduler } from '../src/multi-agent/scheduler.js'
import { PlannerContextBuilder, ExecutorContextBuilder, redactSecrets } from '../src/multi-agent/context-builder.js'
import { MultiAgentStateStore, markInterruptedSteps } from '../src/multi-agent/state-store.js'
import { MultiAgentOrchestrator } from '../src/multi-agent/orchestrator.js'
import { MULTI_AGENT_SCENARIOS, runMultiAgentEvaluation } from '../src/evaluation/multi-agent.js'
import type { MultiAgentRunState, PlanStep, TaskPlan } from '../src/multi-agent/types.js'
import { MULTI_AGENT_SCHEMA_VERSION, defaultMultiAgentBudgets } from '../src/multi-agent/types.js'
import { readFileTool } from '../src/tools/read-file.js'
import { listFilesTool } from '../src/tools/list-files.js'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-multi-agent-test-'))
}

function noopTool(name: string): ToolDefinition<{ value?: string }> {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    schema: {
      safeParse(input: unknown) {
        return { success: true, data: input as { value?: string } }
      },
    } as ToolDefinition<{ value?: string }>['schema'],
    async run() {
      return { ok: true, output: 'ok' }
    },
  }
}

function step(id: string, patch: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: id,
    description: id,
    dependsOn: [],
    allowedTools: ['none'],
    expectedInputs: [],
    expectedOutputs: [`${id}-out`],
    successCriteria: [{ id: `${id}-done`, type: 'custom_evaluator' }],
    maxAttempts: 2,
    optional: false,
    ...patch,
  }
}

function plan(steps: PlanStep[]): TaskPlan {
  return {
    schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
    planId: 'plan-test',
    objective: 'test objective',
    assumptions: [],
    constraints: [],
    successCriteria: [{ id: 'task', type: 'custom_evaluator' }],
    steps,
    createdAt: new Date().toISOString(),
    revision: 1,
  }
}

function validator(tools = ['none', 'read_file', 'list_files']): PlanValidator {
  return new PlanValidator({ registeredTools: tools, maxSteps: 10 })
}

function state(taskPlan: TaskPlan): MultiAgentRunState {
  return {
    schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
    runId: 'run-test',
    objective: taskPlan.objective,
    status: 'ready',
    currentPlan: taskPlan,
    planHistory: [taskPlan],
    stepResults: {},
    plannerCalls: 1,
    executorCalls: 0,
    toolCalls: 0,
    replanCount: 0,
    budgets: defaultMultiAgentBudgets(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('multi-agent plan validator', () => {
  it('accepts a valid plan', () => {
    assert.deepEqual(validator().validate(plan([step('A')])), [])
  })

  it('rejects missing top-level fields', () => {
    assert.throws(() => validator().validateOrThrow({ steps: [] } as unknown as TaskPlan), /required|at least/)
  })

  it('rejects duplicate step ids', () => {
    assert.throws(() => validator().validateOrThrow(plan([step('A'), step('A')])), /Duplicate/)
  })

  it('rejects unknown dependencies', () => {
    assert.throws(() => validator().validateOrThrow(plan([step('B', { dependsOn: ['A'] })])), /Unknown dependency/)
  })

  it('rejects dependency cycles', () => {
    assert.throws(
      () => validator().validateOrThrow(plan([step('A', { dependsOn: ['B'] }), step('B', { dependsOn: ['A'] })])),
      /cycle/i,
    )
  })

  it('rejects self dependency', () => {
    assert.throws(() => validator().validateOrThrow(plan([step('A', { dependsOn: ['A'] })])), /itself/)
  })

  it('rejects unknown tools', () => {
    assert.throws(() => validator(['none']).validateOrThrow(plan([step('A', { allowedTools: ['missing_tool'] })])), /Unknown tool/)
  })

  it('rejects forbidden tools', () => {
    assert.throws(() => validator(['web_fetch']).validateOrThrow(plan([step('A', { allowedTools: ['web_fetch'] })])), /Forbidden/)
  })

  it('rejects too many steps', () => {
    assert.throws(
      () => new PlanValidator({ registeredTools: ['none'], maxSteps: 1 }).validateOrThrow(plan([step('A'), step('B')])),
      /too many/i,
    )
  })

  it('rejects oversized plan json', () => {
    assert.throws(
      () => new PlanValidator({ registeredTools: ['none'], maxJsonBytes: 10 }).validateOrThrow(plan([step('A')])),
      /too large/i,
    )
  })
})

describe('multi-agent scheduler', () => {
  it('selects a single ready step', () => {
    const result = new StepScheduler().schedule(state(plan([step('A')])))
    assert.equal(result.selectedStep?.id, 'A')
  })

  it('honors linear dependencies', () => {
    const s = state(plan([step('A'), step('B', { dependsOn: ['A'] })]))
    assert.equal(new StepScheduler().schedule(s).selectedStep?.id, 'A')
    s.stepResults.A = completed('A')
    assert.equal(new StepScheduler().schedule(s).selectedStep?.id, 'B')
  })

  it('keeps stable order for multiple ready steps', () => {
    assert.equal(new StepScheduler().schedule(state(plan([step('B'), step('A')]))).selectedStep?.id, 'B')
  })

  it('blocks downstream failed dependencies', () => {
    const s = state(plan([step('A'), step('B', { dependsOn: ['A'] })]))
    s.stepResults.A = { ...completed('A'), status: 'failed' }
    const result = new StepScheduler().schedule(s)
    assert.equal(result.selectedStep, undefined)
    assert.deepEqual(result.blockedSteps.map(item => item.id), ['A', 'B'])
  })

  it('reports all completed', () => {
    const s = state(plan([step('A')]))
    s.stepResults.A = completed('A')
    assert.equal(new StepScheduler().schedule(s).reason, 'all steps completed')
  })
})

describe('multi-agent context isolation', () => {
  it('redacts secrets', () => {
    assert.equal(redactSecrets('OPENAI_API_KEY=sk-test TEST_SECRET_MARKER'), '[REDACTED] [REDACTED]')
  })

  it('planner context contains tool summaries without mutating input', () => {
    const tools = [{ name: 'read_file', description: 'read' }]
    const context = new PlannerContextBuilder().build({
      objective: 'hello TEST_SECRET_MARKER',
      constraints: ['no network'],
      tools,
      budgets: defaultMultiAgentBudgets(),
    })
    assert.equal(context.objective.includes('TEST_SECRET_MARKER'), false)
    assert.deepEqual(tools, [{ name: 'read_file', description: 'read' }])
  })

  it('executor context only includes current step and dependency summaries', () => {
    const p = plan([step('A'), step('B', { dependsOn: ['A'] }), step('C')])
    const s = state(p)
    s.objective = 'goal TEST_SECRET_MARKER'
    s.stepResults.A = completed('A')
    const context = new ExecutorContextBuilder().build({
      state: s,
      stepId: 'B',
      cwd: process.cwd(),
      attempt: 1,
    })
    assert.equal(context.step.id, 'B')
    assert.deepEqual(context.dependencyOutputs.map(item => item.stepId), ['A'])
    assert.equal(context.objectiveSummary.includes('TEST_SECRET_MARKER'), false)
  })
})

describe('multi-agent state store', () => {
  it('saves and loads checkpoint', async () => {
    const store = new MultiAgentStateStore(await tempDir())
    const s = state(plan([step('A')]))
    await store.saveState(s)
    const loaded = await store.loadState(s.runId)
    assert.equal(loaded.runId, s.runId)
  })

  it('rejects corrupted checkpoint json', async () => {
    const dir = await tempDir()
    const store = new MultiAgentStateStore(dir)
    const runDir = path.join(dir, 'multi-agent-runs', 'bad')
    await writeFile(path.join(runDir, 'state.json'), '{bad', { encoding: 'utf8', flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(runDir, { recursive: true })
      await writeFile(path.join(runDir, 'state.json'), '{bad', 'utf8')
    })
    await assert.rejects(store.loadState('bad'), /Cannot read checkpoint/)
  })

  it('marks interrupted executing step', () => {
    const s = state(plan([step('A')]))
    s.status = 'executing_step'
    s.currentStepId = 'A'
    const next = markInterruptedSteps(s)
    assert.equal(next.stepResults.A?.status, 'interrupted')
    assert.equal(next.status, 'ready')
  })
})

describe('multi-agent orchestrator and evaluation', () => {
  it('runs simple plan to completion', async () => {
    const outputDir = await tempDir()
    const state = await orchestrator('simple-plan', outputDir).run()
    assert.equal(state.status, 'completed')
    assert.equal(state.executorCalls, 1)
  })

  it('retries then succeeds', async () => {
    const state = await orchestrator('retry-then-success', await tempDir()).run()
    assert.equal(state.status, 'completed')
    assert.equal(state.executorCalls, 2)
  })

  it('replans around failure', async () => {
    const state = await orchestrator('failure-then-replan', await tempDir()).run()
    assert.equal(state.status, 'completed')
    assert.equal(state.replanCount, 1)
    assert.ok(state.currentPlan.steps.some(item => item.id === 'replacement-step'))
  })

  it('enforces tool budget', async () => {
    const state = await orchestrator('tool-budget-exceeded', await tempDir(), { maxToolCalls: 2 }).run()
    assert.equal(state.status, 'budget_exceeded')
  })

  it('resumes without repeating completed steps', async () => {
    const outputDir = await tempDir()
    const first = await orchestrator('checkpoint-resume', outputDir, undefined, 1).run()
    const resumed = await orchestrator('checkpoint-resume', outputDir, undefined, undefined, first.runId).run()
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.stepResults.A?.status, 'completed')
  })

  it('defines at least 14 scenarios', () => {
    assert.ok(MULTI_AGENT_SCENARIOS.length >= 14)
  })

  it('runs all multi-agent scenarios', async () => {
    const summary = await runMultiAgentEvaluation({ outputDir: await tempDir(), all: true })
    assert.equal(summary.results.length, MULTI_AGENT_SCENARIOS.length)
    assert.equal(summary.results.every(result => result.status === 'passed'), true)
    assert.equal(summary.metrics.checkpoint_recovery_rate, 1)
  })
})

function completed(stepId: string) {
  return {
    stepId,
    status: 'completed' as const,
    attempt: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    assistantResponse: `${stepId} done`,
    toolCalls: [],
    artifacts: [{ id: `${stepId}-artifact`, path: `memory://${stepId}`, kind: 'text' as const, summary: `${stepId} done` }],
    reviewerAssertions: [],
  }
}

function orchestrator(
  scenario: string,
  outputDir: string,
  budgets?: Parameters<typeof MultiAgentOrchestrator>[0]['budgets'],
  stopAfterSteps?: number,
  resume?: string,
): MultiAgentOrchestrator {
  return new MultiAgentOrchestrator({
    objective: MULTI_AGENT_SCENARIOS.find(item => item.id === scenario)?.objective ?? scenario,
    cwd: process.cwd(),
    outputDir,
    tools: new ToolRegistry([readFileTool, listFilesTool, noopTool('none')]),
    scenario,
    budgets,
    stopAfterSteps,
    resume,
  })
}
