import { randomUUID } from 'node:crypto'
import type { PlanStep, PlannerAgent, PlannerRequest, ReplanRequest, SuccessCriterion, TaskPlan } from './types.js'
import { MULTI_AGENT_SCHEMA_VERSION } from './types.js'

type PlanVariant =
  | 'simple-plan'
  | 'read-package-metadata'
  | 'multi-step-dependencies'
  | 'parallel-ready-serial-execution'
  | 'invalid-plan-schema'
  | 'dependency-cycle'
  | 'forbidden-tool-in-plan'
  | 'retry-then-success'
  | 'failure-then-replan'
  | 'max-replans-exceeded'
  | 'checkpoint-resume'
  | 'context-isolation'
  | 'tool-budget-exceeded'
  | 'executor-forbidden-tool'

const doneCriterion = (id = 'done'): SuccessCriterion => ({
  id,
  type: 'custom_evaluator',
  expected: 'completed',
})

function step(input: Partial<PlanStep> & Pick<PlanStep, 'id'>): PlanStep {
  return {
    id: input.id,
    title: input.title ?? input.id,
    description: input.description ?? `Execute ${input.id}`,
    dependsOn: input.dependsOn ?? [],
    allowedTools: input.allowedTools ?? ['none'],
    expectedInputs: input.expectedInputs ?? [],
    expectedOutputs: input.expectedOutputs ?? [`${input.id}-output`],
    successCriteria: input.successCriteria ?? [doneCriterion(`${input.id}-done`)],
    maxAttempts: input.maxAttempts ?? 2,
    optional: input.optional ?? false,
    parallelizable: input.parallelizable,
  }
}

function plan(args: {
  objective: string
  revision?: number
  steps: PlanStep[]
  assumptions?: string[]
  constraints?: string[]
  successCriteria?: SuccessCriterion[]
}): TaskPlan {
  return {
    schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
    planId: `plan-${randomUUID()}`,
    objective: args.objective,
    assumptions: args.assumptions ?? ['offline deterministic planner'],
    constraints: args.constraints ?? ['no real model', 'no network', 'no real MCP'],
    successCriteria: args.successCriteria ?? [doneCriterion('task-complete')],
    steps: args.steps,
    createdAt: new Date().toISOString(),
    revision: args.revision ?? 1,
  }
}

export class MockPlannerAgent implements PlannerAgent {
  async createPlan(request: PlannerRequest): Promise<TaskPlan> {
    const scenario = (request.scenario ?? 'simple-plan') as PlanVariant
    if (scenario === 'invalid-plan-schema') {
      return { objective: request.objective, steps: [] } as unknown as TaskPlan
    }
    if (scenario === 'dependency-cycle') {
      return plan({
        objective: request.objective,
        steps: [
          step({ id: 'A', dependsOn: ['B'] }),
          step({ id: 'B', dependsOn: ['A'] }),
        ],
      })
    }
    if (scenario === 'forbidden-tool-in-plan') {
      return plan({
        objective: request.objective,
        steps: [step({ id: 'forbidden', allowedTools: ['web_fetch'] })],
      })
    }
    if (scenario === 'read-package-metadata') {
      return plan({
        objective: request.objective,
        steps: [
          step({
            id: 'read-package',
            title: 'Read package metadata',
            allowedTools: ['read_file'],
            expectedOutputs: ['package.json content'],
            successCriteria: [{ id: 'read-called', type: 'tool_called', target: 'read_file' }],
          }),
          step({
            id: 'summarize-package',
            dependsOn: ['read-package'],
            allowedTools: ['none'],
            expectedInputs: ['package.json content'],
            expectedOutputs: ['project name and script count'],
          }),
        ],
      })
    }
    if (scenario === 'multi-step-dependencies' || scenario === 'checkpoint-resume') {
      return plan({
        objective: request.objective,
        steps: [
          step({ id: 'A' }),
          step({ id: 'B', dependsOn: ['A'] }),
          step({ id: 'C', dependsOn: ['B'] }),
        ],
      })
    }
    if (scenario === 'parallel-ready-serial-execution') {
      return plan({
        objective: request.objective,
        steps: [
          step({ id: 'A', parallelizable: true }),
          step({ id: 'B', parallelizable: true }),
          step({ id: 'C', dependsOn: ['A', 'B'] }),
        ],
      })
    }
    if (scenario === 'retry-then-success') {
      return plan({ objective: request.objective, steps: [step({ id: 'retry-step', maxAttempts: 2 })] })
    }
    if (scenario === 'failure-then-replan' || scenario === 'max-replans-exceeded') {
      return plan({
        objective: request.objective,
        steps: [
          step({ id: 'stable-start' }),
          step({ id: 'failing-step', dependsOn: ['stable-start'], maxAttempts: 1 }),
        ],
      })
    }
    if (scenario === 'tool-budget-exceeded') {
      return plan({
        objective: request.objective,
        steps: [step({ id: 'tool-loop', allowedTools: ['read_file'], maxAttempts: 1 })],
      })
    }
    if (scenario === 'executor-forbidden-tool') {
      return plan({
        objective: request.objective,
        steps: [step({ id: 'safe-step', allowedTools: ['read_file'], maxAttempts: 1 })],
      })
    }
    return plan({
      objective: request.objective,
      steps: [step({ id: scenario === 'context-isolation' ? 'context-step' : 'final-answer' })],
    })
  }

  async revisePlan(request: ReplanRequest): Promise<TaskPlan> {
    if (request.scenario === 'max-replans-exceeded') {
      return plan({
        objective: request.objective,
        revision: request.previousPlan.revision + 1,
        steps: [
          ...request.previousPlan.steps.filter(step => step.id === 'stable-start'),
          step({ id: `still-failing-${request.previousPlan.revision}`, dependsOn: ['stable-start'], maxAttempts: 1 }),
        ],
      })
    }
    return plan({
      objective: request.objective,
      revision: request.previousPlan.revision + 1,
      steps: [
        ...request.previousPlan.steps.filter(step => step.id === 'stable-start'),
        step({ id: 'replacement-step', dependsOn: ['stable-start'], maxAttempts: 1 }),
      ],
    })
  }
}

export class ScriptedPlannerAgent extends MockPlannerAgent {}
