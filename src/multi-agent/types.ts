import type { EvalAssertionResult, FailureStage } from '../evaluation/types.js'

export const MULTI_AGENT_SCHEMA_VERSION = '1.0'

export type SuccessCriterionType =
  | 'file_exists'
  | 'file_not_exists'
  | 'text_contains'
  | 'text_not_contains'
  | 'tool_called'
  | 'tool_not_called'
  | 'exit_code'
  | 'trace_event_exists'
  | 'artifact_exists'
  | 'json_path_equals'
  | 'custom_evaluator'

export type SuccessCriterion = {
  id: string
  type: SuccessCriterionType
  target?: string
  expected?: unknown
}

export type PlanStep = {
  id: string
  title: string
  description: string
  dependsOn: string[]
  allowedTools: string[]
  expectedInputs: string[]
  expectedOutputs: string[]
  successCriteria: SuccessCriterion[]
  maxAttempts: number
  optional: boolean
  parallelizable?: boolean
}

export type TaskPlan = {
  schemaVersion: string
  planId: string
  objective: string
  assumptions: string[]
  constraints: string[]
  successCriteria: SuccessCriterion[]
  steps: PlanStep[]
  createdAt: string
  revision: number
}

export type ArtifactReference = {
  id: string
  path: string
  kind: 'file' | 'json' | 'text' | 'directory'
  bytes?: number
  summary?: string
}

export type StepToolCallRecord = {
  id: string
  toolName: string
  inputSummary: string
  ok: boolean
  outputSummary: string
}

export type StepExecutionStatus =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled'
  | 'interrupted'

export type StepExecutionResult = {
  stepId: string
  status: StepExecutionStatus
  attempt: number
  startedAt: string
  completedAt: string
  durationMs: number
  assistantResponse?: string
  toolCalls: StepToolCallRecord[]
  artifacts: ArtifactReference[]
  failureStage?: FailureStage | string
  errorCode?: string
  errorMessage?: string
  reviewerAssertions: EvalAssertionResult[]
  traceRunId?: string
}

export type MultiAgentStatus =
  | 'created'
  | 'planning'
  | 'validating_plan'
  | 'ready'
  | 'executing_step'
  | 'reviewing_step'
  | 'step_completed'
  | 'replanning'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'budget_exceeded'

export type MultiAgentBudgets = {
  maxPlanSteps: number
  maxPlannerCalls: number
  maxExecutorCalls: number
  maxToolCalls: number
  maxReplans: number
  maxTotalDurationMs: number
  maxArtifacts: number
  maxArtifactBytes: number
}

export type MultiAgentRunState = {
  schemaVersion: string
  runId: string
  objective: string
  status: MultiAgentStatus
  currentPlan: TaskPlan
  planHistory: TaskPlan[]
  stepResults: Record<string, StepExecutionResult>
  currentStepId?: string
  plannerCalls: number
  executorCalls: number
  toolCalls: number
  replanCount: number
  budgets: MultiAgentBudgets
  createdAt: string
  updatedAt: string
  gitCommit?: string
  terminationReason?: string
}

export type CompletedStepSummary = {
  stepId: string
  title: string
  outputs: string[]
  artifacts: ArtifactReference[]
}

export type ReplanFailureSummary = {
  failedStepId: string
  failureStage: string
  errorCode?: string
  errorSummary: string
  attempts: number
  completedSteps: CompletedStepSummary[]
  remainingBudget: MultiAgentBudgets
}

export type PlannerRequest = {
  objective: string
  constraints: string[]
  availableTools: Array<{ name: string; description: string }>
  successCriteria: SuccessCriterion[]
  budgets: MultiAgentBudgets
  scenario?: string
}

export type ReplanRequest = PlannerRequest & {
  previousPlan: TaskPlan
  failure: ReplanFailureSummary
}

export type PlannerAgent = {
  createPlan(request: PlannerRequest): Promise<TaskPlan>
  revisePlan(request: ReplanRequest): Promise<TaskPlan>
}

export type ExecuteStepRequest = {
  objectiveSummary: string
  planRevision: number
  step: PlanStep
  dependencyOutputs: CompletedStepSummary[]
  allowedTools: string[]
  cwd: string
  attempt: number
  budgets: MultiAgentBudgets
  scenario?: string
  injectFailure?: string
}

export type ExecutorAgent = {
  executeStep(request: ExecuteStepRequest): Promise<StepExecutionResult>
}

export type StepReviewResult = {
  status: 'passed' | 'failed'
  assertions: EvalAssertionResult[]
  failureStage?: FailureStage | string
  errorCode?: string
}

export type TaskReviewResult = StepReviewResult

export type DeterministicReviewer = {
  reviewStep(args: {
    plan: TaskPlan
    step: PlanStep
    result: StepExecutionResult
  }): Promise<StepReviewResult>
  reviewTask(args: {
    state: MultiAgentRunState
  }): Promise<TaskReviewResult>
}

export type SchedulerResult = {
  selectedStep?: PlanStep
  readySteps: PlanStep[]
  blockedSteps: PlanStep[]
  completedSteps: PlanStep[]
  reason: string
}

export type MultiAgentTraceEvent = {
  event_type: string
  timestamp: string
  run_id: string
  plan_id?: string
  plan_revision?: number
  step_id?: string
  step_attempt?: number
  planner_call_count?: number
  executor_call_count?: number
  tool_call_count?: number
  replan_count?: number
  state_before?: MultiAgentStatus
  state_after?: MultiAgentStatus
  failure_stage?: string
  termination_reason?: string
  [key: string]: unknown
}

export type MultiAgentScenarioResult = {
  scenario: string
  status: 'passed' | 'failed' | 'error'
  state: MultiAgentRunState
  assertions: EvalAssertionResult[]
  tracePath?: string
  statePath?: string
  badcasePath?: string
}

export function defaultMultiAgentBudgets(): MultiAgentBudgets {
  return {
    maxPlanSteps: 10,
    maxPlannerCalls: 3,
    maxExecutorCalls: 20,
    maxToolCalls: 20,
    maxReplans: 2,
    maxTotalDurationMs: 120_000,
    maxArtifacts: 20,
    maxArtifactBytes: 20 * 1024 * 1024,
  }
}
