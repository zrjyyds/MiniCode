import type { AgentLoopObserver } from '../debug/harness-trace.js'
import type { SandboxErrorCode } from './errors.js'

export type CommandExecutionBackend = 'host' | 'docker'

export type CleanupStatus = 'not_required' | 'success' | 'failed' | 'skipped'

export type CommandExecutionRequest = {
  command: string
  args: string[]
  workingDirectory: string
  timeoutMs?: number
  environment?: Record<string, string | undefined>
  maxOutputBytes?: number
  runId?: string
  useShell?: boolean
  trace?: AgentLoopObserver
  turnIndex?: number
}

export type CommandExecutionResult = {
  backend: CommandExecutionBackend
  exitCode: number | null
  signal?: NodeJS.Signals | string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutBytes: number
  stderrBytes: number
  timedOut: boolean
  durationMs: number
  containerId?: string
  containerName?: string
  workspacePath?: string
  cleanupStatus: CleanupStatus
  errorCode?: SandboxErrorCode
}

export type CommandExecutor = {
  readonly backend: CommandExecutionBackend
  execute(request: CommandExecutionRequest): Promise<CommandExecutionResult>
}

export type DockerResourceLimits = {
  cpus: string
  memory: string
  memorySwap: string
  pidsLimit: number
  nofile: string
  tmpfsSize: string
}

export type DockerSandboxConfig = {
  image: string
  runtimeRoot: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
  defaultOutputBytes: number
  maxOutputBytes: number
  snapshotMaxBytes: number
  snapshotMaxFiles: number
  resources: DockerResourceLimits
  user: string
}

export type DockerRunSpec = {
  args: string[]
  containerName: string
  image: string
  workspacePath: string
  command: string
  security: Record<string, unknown>
}

export type DockerCliResult = {
  exitCode: number
  signal?: NodeJS.Signals | string | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
}

export type DockerCliRunner = (
  args: string[],
  options: {
    cwd?: string
    timeoutMs: number
    maxOutputBytes: number
  },
) => Promise<DockerCliResult>
