import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommandExecutionRequest, CommandExecutionResult, CommandExecutor } from './types.js'
import { limitOutput } from './output-limiter.js'

const execFileAsync = promisify(execFile)

export class HostCommandExecutor implements CommandExecutor {
  readonly backend = 'host' as const

  async execute(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const startedAt = Date.now()
    const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024
    try {
      const result = await execFileAsync(request.command, request.args, {
        cwd: request.workingDirectory,
        maxBuffer: maxOutputBytes,
        env: request.environment ?? process.env,
        timeout: request.timeoutMs,
      })
      const stdout = limitOutput(result.stdout ?? '', maxOutputBytes)
      const stderr = limitOutput(result.stderr ?? '', maxOutputBytes)
      return {
        backend: this.backend,
        exitCode: 0,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.totalObservedBytes,
        stderrBytes: stderr.totalObservedBytes,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        cleanupStatus: 'not_required',
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer
        stderr?: string | Buffer
        code?: number | string
        signal?: NodeJS.Signals | string
        killed?: boolean
      }
      const stdout = limitOutput(err.stdout ?? '', maxOutputBytes)
      const stderr = limitOutput(err.stderr ?? err.message ?? '', maxOutputBytes)
      return {
        backend: this.backend,
        exitCode: typeof err.code === 'number' ? err.code : null,
        signal: err.signal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.totalObservedBytes,
        stderrBytes: stderr.totalObservedBytes,
        timedOut: Boolean(err.killed),
        durationMs: Date.now() - startedAt,
        cleanupStatus: 'not_required',
        errorCode: err.killed ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED',
      }
    }
  }
}
