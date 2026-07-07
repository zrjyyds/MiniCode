export type MultiAgentErrorCode =
  | 'PLAN_SCHEMA_INVALID'
  | 'PLAN_DUPLICATE_STEP_ID'
  | 'PLAN_UNKNOWN_DEPENDENCY'
  | 'PLAN_DEPENDENCY_CYCLE'
  | 'PLAN_UNKNOWN_TOOL'
  | 'PLAN_FORBIDDEN_TOOL'
  | 'PLAN_TOO_MANY_STEPS'
  | 'PLAN_BUDGET_EXCEEDED'
  | 'PLAN_REVISION_INVALID'
  | 'TOOL_NOT_ALLOWED'
  | 'INVALID_STATE_TRANSITION'
  | 'CHECKPOINT_INVALID'
  | 'ENVIRONMENT_MISMATCH'

export class MultiAgentError extends Error {
  constructor(
    readonly code: MultiAgentErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'MultiAgentError'
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
