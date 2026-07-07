import type { TraceMode } from '../debug/harness-trace.js'

export const EVAL_SCHEMA_VERSION = '1.0'

export type EvalCategory =
  | 'basic'
  | 'tool'
  | 'security'
  | 'compaction'
  | 'termination'
  | 'observability'

export type EvalStatus = 'passed' | 'failed' | 'error' | 'skipped'

export type FailureStage =
  | 'SETUP'
  | 'INPUT'
  | 'CONTEXT_BUILD'
  | 'COMPACTION'
  | 'MODEL_REQUEST'
  | 'MODEL_RESPONSE'
  | 'TOOL_SELECTION'
  | 'TOOL_ARGUMENT'
  | 'PERMISSION'
  | 'TOOL_EXECUTION'
  | 'TOOL_RESULT'
  | 'MESSAGE_UPDATE'
  | 'TERMINATION'
  | 'FINAL_RESPONSE'
  | 'SECURITY'
  | 'CLEANUP'
  | 'EVALUATION_INFRASTRUCTURE'

export type NumberExpectation =
  | { equals: number }
  | { minimum: number }
  | { maximum: number }
  | { range: [number, number] }

export type TextExpectation = {
  contains?: string[]
  notContains?: string[]
  matches?: string[]
  nonEmpty?: boolean
}

export type ValueExpectation =
  | { equals: unknown }
  | { partial: Record<string, unknown> }
  | { pathEquals: string }
  | { matches: string }

export type ExpectedToolCall = {
  name: string
  status?: 'success' | 'failed'
  input?: ValueExpectation
}

export type CompactionExpectation = {
  checked?: boolean
  applied?: boolean
  type?: string
  messageCountReduced?: boolean
  boundaryRole?: string
}

export type SecurityExpectation = {
  noSecretLeakage?: boolean
  noWorkspaceEscape?: boolean
  forbiddenTools?: string[]
  noNetwork?: boolean
}

export type EvalExpectations = {
  status?: 'passed' | 'failed' | 'completed'
  terminationReason?: string | string[]
  expectedFailureStage?: FailureStage
  expectedRoleSequence?: string[]
  roleSequenceMode?: 'exact' | 'subsequence' | 'prefix'
  requiredEventTypes?: string[]
  forbiddenEventTypes?: string[]
  modelCallCount?: NumberExpectation
  toolCallCount?: NumberExpectation
  expectedTools?: ExpectedToolCall[]
  forbiddenTools?: string[]
  expectedPermissionDecisions?: string[]
  expectedCompaction?: CompactionExpectation
  finalResponse?: TextExpectation
  security?: SecurityExpectation
}

export type EvalSetup =
  | { kind: 'none' }
  | { kind: 'large-tool-result' }
  | { kind: 'long-conversation' }
  | { kind: 'invalid-tool-arguments' }
  | { kind: 'forbidden-tool' }
  | { kind: 'max-turn' }
  | { kind: 'observer-failure' }

export type EvalCleanup = {
  removeFixtures?: boolean
}

export type AgentEvalCase = {
  schemaVersion: string
  id: string
  name: string
  description: string
  category: EvalCategory
  tags: string[]
  input: {
    userMessage: string
    workingDirectory?: string
    traceMode?: TraceMode
    maxTurns?: number
  }
  setup?: EvalSetup
  expected: EvalExpectations
  cleanup?: EvalCleanup
}

export type EvalAssertionResult = {
  id: string
  category: string
  passed: boolean
  expected: unknown
  actual: unknown
  message: string
  failureStage?: FailureStage
}

export type EvalMetrics = {
  taskSuccess: boolean
  completed: boolean
  crashed: boolean
  timeout: boolean
  trajectoryValid: boolean
  roleSequenceMatched: boolean
  terminationCorrect: boolean
  toolSelectionCorrect: boolean
  toolArgumentCorrect: boolean
  toolResultReturned: boolean
  unauthorizedActions: number
  secretLeakages: number
  forbiddenToolExecutions: number
  compactionTriggered: boolean
  compactionCompleted: boolean
  contextReductionRatio: number
  transcriptPreserved: boolean
  turns: number
  toolCalls: number
  durationMs: number
  traceParseErrors: number
}

export type AgentEvalResult = {
  schemaVersion: string
  evaluationRunId: string
  caseId: string
  status: EvalStatus
  startedAt: string
  completedAt: string
  durationMs: number
  assertions: EvalAssertionResult[]
  metrics: EvalMetrics
  failureStage?: FailureStage
  observedFailureStage?: FailureStage
  failureReasons: string[]
  tracePath?: string
  summaryPath?: string
  badcasePath?: string
}

export type EvaluationSummary = {
  schemaVersion: string
  evaluationRunId: string
  startedAt: string
  completedAt: string
  durationMs: number
  results: AgentEvalResult[]
  metrics: Record<string, number>
  baseline?: Record<string, unknown>
}

export type ReplayStatus =
  | 'REPRODUCED'
  | 'NOT_REPRODUCED'
  | 'RESOLVED'
  | 'REPLAY_ERROR'
  | 'ENVIRONMENT_MISMATCH'

export type ReplayResult = {
  schemaVersion: string
  status: ReplayStatus
  originalCaseId: string
  replayedCaseId?: string
  originalFailureStage?: FailureStage
  replayFailureStage?: FailureStage
  compared: boolean
  outputDir?: string
  reasons: string[]
}

export function createEmptyMetrics(): EvalMetrics {
  return {
    taskSuccess: false,
    completed: false,
    crashed: false,
    timeout: false,
    trajectoryValid: false,
    roleSequenceMatched: false,
    terminationCorrect: false,
    toolSelectionCorrect: false,
    toolArgumentCorrect: false,
    toolResultReturned: false,
    unauthorizedActions: 0,
    secretLeakages: 0,
    forbiddenToolExecutions: 0,
    compactionTriggered: false,
    compactionCompleted: false,
    contextReductionRatio: 0,
    transcriptPreserved: true,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    traceParseErrors: 0,
  }
}
