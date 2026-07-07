import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { buildDockerRunSpec, defaultDockerSandboxConfig, validateDockerRunArgs } from './docker-command-builder.js'
import { SandboxExecutionError, errorMessage } from './errors.js'
import { OutputLimiter } from './output-limiter.js'
import { cleanupSnapshot, createWorkspaceSnapshot } from './workspace-snapshot.js'
import type {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandExecutor,
  DockerCliResult,
  DockerCliRunner,
  DockerSandboxConfig,
} from './types.js'

export class DockerSandboxExecutor implements CommandExecutor {
  readonly backend = 'docker' as const

  constructor(
    private readonly config: DockerSandboxConfig = defaultDockerSandboxConfig(),
    private readonly runner: DockerCliRunner = runDockerCli,
  ) {}

  async execute(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const startedAt = Date.now()
    const runId = request.runId ?? randomUUID()
    const timeoutMs = bounded(request.timeoutMs ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs, 'timeout')
    const maxOutputBytes = bounded(request.maxOutputBytes ?? this.config.defaultOutputBytes, this.config.maxOutputBytes, 'output')
    const turnIndex = request.turnIndex ?? 0
    let runRoot: string | undefined
    let containerName: string | undefined
    let cleanupStatus: CommandExecutionResult['cleanupStatus'] = 'skipped'

    const emit = async (event_type: string, extra: Record<string, unknown> = {}) => {
      await request.trace?.onEvent({
        event_type: event_type as never,
        turn_index: turnIndex,
        execution_backend: this.backend,
        ...extra,
      })
    }

    await emit('sandbox_requested', {
      image: this.config.image,
      timeout_ms: timeoutMs,
      output_limit: maxOutputBytes,
    })

    const availability = await this.checkDockerAvailable(maxOutputBytes)
    if (!availability.available) {
      const reason = availability.reason ?? 'docker unavailable'
      await emit('sandbox_failed', { error_code: 'SANDBOX_UNAVAILABLE', error_message: reason })
      return failureResult(startedAt, 'SANDBOX_UNAVAILABLE', reason, cleanupStatus)
    }

    try {
      const snapshot = await createWorkspaceSnapshot({
        sourceDirectory: request.workingDirectory,
        runtimeRoot: this.config.runtimeRoot,
        runId,
        maxBytes: this.config.snapshotMaxBytes,
        maxFiles: this.config.snapshotMaxFiles,
      })
      runRoot = snapshot.runRoot
      await emit('sandbox_workspace_created', {
        workspace_mount: snapshot.workspacePath,
        snapshot_files: snapshot.fileCount,
        snapshot_bytes: snapshot.totalBytes,
      })

      const spec = buildDockerRunSpec({
        config: this.config,
        runId,
        workspacePath: snapshot.workspacePath,
        command: shellCommandForRequest(request),
        environment: request.environment,
        faultInjection: process.env.MINI_CODE_SANDBOX_FAULT === 'omit-network-none'
          ? 'omit-network-none'
          : undefined,
      })
      containerName = spec.containerName
      validateDockerRunArgs(spec.args, this.config.runtimeRoot)
      await emit('sandbox_container_starting', {
        image: spec.image,
        container_name: spec.containerName,
        ...spec.security,
      })
      await emit('sandbox_command_started', { container_name: spec.containerName })
      const result = await this.runner(spec.args, {
        cwd: path.resolve(request.workingDirectory),
        timeoutMs,
        maxOutputBytes,
      })
      await emit('sandbox_container_started', { container_name: spec.containerName })
      if (result.stdoutTruncated || result.stderrTruncated) {
        await emit('sandbox_output_truncated', {
          stdout_bytes: result.stdoutBytes,
          stderr_bytes: result.stderrBytes,
          output_limit: maxOutputBytes,
        })
      }
      if (result.timedOut) {
        await emit('sandbox_command_timeout', { container_name: spec.containerName, timeout_ms: timeoutMs })
      }
      cleanupStatus = await this.cleanupContainer(spec.containerName, maxOutputBytes)
      await emit('sandbox_container_cleanup', { container_name: spec.containerName, cleanup_status: cleanupStatus })
      await emit('sandbox_command_completed', {
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        cleanup_status: cleanupStatus,
      })
      return {
        backend: this.backend,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt,
        containerName,
        workspacePath: snapshot.workspacePath,
        cleanupStatus,
        errorCode: result.timedOut ? 'COMMAND_TIMEOUT' : result.exitCode === 0 ? undefined : 'COMMAND_FAILED',
      }
    } catch (error) {
      const code = error instanceof SandboxExecutionError ? error.code : 'CONTAINER_START_FAILED'
      await emit('sandbox_failed', { error_code: code, error_message: errorMessage(error), container_name: containerName })
      return failureResult(startedAt, code, errorMessage(error), cleanupStatus, containerName)
    } finally {
      if (runRoot) {
        try {
          if (process.env.MINI_CODE_KEEP_SANDBOX_WORKSPACE !== '1') {
            await cleanupSnapshot(runRoot, this.config.runtimeRoot)
          }
        } catch {
          cleanupStatus = 'failed'
        }
      }
    }
  }

  private async checkDockerAvailable(maxOutputBytes: number): Promise<{ available: boolean; reason?: string }> {
    try {
      const result = await this.runner(['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 5_000,
        maxOutputBytes,
      })
      return result.exitCode === 0
        ? { available: true }
        : { available: false, reason: result.stderr || result.stdout || 'docker daemon unavailable' }
    } catch (error) {
      return { available: false, reason: errorMessage(error) }
    }
  }

  private async cleanupContainer(containerName: string, maxOutputBytes: number): Promise<CommandExecutionResult['cleanupStatus']> {
    try {
      await this.runner(['rm', '-f', containerName], {
        timeoutMs: 5_000,
        maxOutputBytes,
      })
      return 'success'
    } catch {
      return 'failed'
    }
  }
}

function shellCommandForRequest(request: CommandExecutionRequest): string {
  if (request.useShell) {
    return request.args.length >= 2 && request.args[0] === '-lc'
      ? request.args.slice(1).join(' ')
      : [request.command, ...request.args].join(' ')
  }
  return [request.command, ...request.args.map(arg => shellQuote(arg))].join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function bounded(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new SandboxExecutionError('SECURITY_POLICY_DENIED', `${label} exceeds allowed bounds`)
  }
  return value
}

function failureResult(
  startedAt: number,
  code: CommandExecutionResult['errorCode'],
  message: string,
  cleanupStatus: CommandExecutionResult['cleanupStatus'],
  containerName?: string,
): CommandExecutionResult {
  return {
    backend: 'docker',
    exitCode: null,
    stdout: '',
    stderr: message,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(message),
    timedOut: code === 'COMMAND_TIMEOUT',
    durationMs: Date.now() - startedAt,
    containerName,
    cleanupStatus,
    errorCode: code,
  }
}

export async function runDockerCli(
  args: string[],
  options: { cwd?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<DockerCliResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const stdout = new OutputLimiter(options.maxOutputBytes)
    const stderr = new OutputLimiter(options.maxOutputBytes)
    const child = spawn('docker', args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, options.timeoutMs)

    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      const out = stdout.result()
      const err = stderr.result()
      resolve({
        exitCode: exitCode ?? (timedOut ? 124 : 1),
        signal,
        stdout: out.text,
        stderr: err.text,
        stdoutBytes: out.totalObservedBytes,
        stderrBytes: err.totalObservedBytes,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}
