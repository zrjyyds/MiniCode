export type SandboxErrorCode =
  | 'SANDBOX_UNAVAILABLE'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_BUILD_FAILED'
  | 'CONTAINER_START_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_FAILED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'WORKSPACE_LIMIT_EXCEEDED'
  | 'CLEANUP_FAILED'
  | 'SECURITY_POLICY_DENIED'

export class SandboxExecutionError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    readonly causeValue?: unknown,
  ) {
    super(message)
    this.name = 'SandboxExecutionError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
