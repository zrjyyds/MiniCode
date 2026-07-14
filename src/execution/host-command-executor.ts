import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CommandExecutionRequest, CommandExecutionResult, CommandExecutor } from './types.js'
import { limitOutput } from './output-limiter.js'

const execFileAsync = promisify(execFile)
const WINDOWS_CMD_EXTENSIONS = new Set(['.cmd', '.bat'])

type HostInvocation = {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function pathextEnv(env: NodeJS.ProcessEnv): string[] {
  const value = envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  return value
    .split(';')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

function candidateCommands(command: string, env: NodeJS.ProcessEnv): string[] {
  const extension = path.extname(command)
  if (extension) return [command]
  return pathextEnv(env).map(ext => `${command}${ext}`)
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, workingDirectory: string): string {
  const candidates = candidateCommands(command, env)
  if (path.isAbsolute(command)) {
    return candidates.find(candidate => existsSync(candidate)) ?? command
  }

  if (hasPathSeparator(command)) {
    for (const candidate of candidates) {
      const resolved = path.resolve(workingDirectory, candidate)
      if (existsSync(resolved)) return resolved
    }
    return command
  }

  const searchPath = envValue(env, 'PATH')
  if (!searchPath) return command
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const fullPath = path.join(directory, candidate)
      if (existsSync(fullPath)) return fullPath
    }
  }
  return command
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) return '""'
  return `"${value.replace(/(["^&|<>%])/g, '^$1')}"`
}

function hostInvocation(request: CommandExecutionRequest, env: NodeJS.ProcessEnv): HostInvocation {
  if (process.platform !== 'win32') {
    return { command: request.command, args: request.args }
  }

  const resolvedCommand = resolveWindowsCommand(request.command, env, request.workingDirectory)
  const extension = path.extname(resolvedCommand).toLowerCase()
  if (!WINDOWS_CMD_EXTENSIONS.has(extension)) {
    return { command: resolvedCommand, args: request.args }
  }

  // Windows .cmd/.bat shims are not directly executable via execFile.
  // Use cmd.exe only for these script shims instead of enabling shell mode globally.
  return {
    command: envValue(env, 'ComSpec') ?? process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[resolvedCommand, ...request.args].map(quoteCmdArg).join(' ')}"`],
    windowsVerbatimArguments: true,
  }
}

function safeChildProcessErrorMessage(error: NodeJS.ErrnoException): string {
  return [
    error.code ? `code=${error.code}` : '',
    typeof error.errno === 'number' ? `errno=${error.errno}` : '',
    error.syscall ? `syscall=${error.syscall}` : '',
    error.path ? `path=${error.path}` : '',
  ].filter(Boolean).join('\n')
}

export class HostCommandExecutor implements CommandExecutor {
  readonly backend = 'host' as const

  async execute(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const startedAt = Date.now()
    const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024
    const env: NodeJS.ProcessEnv = request.environment ?? process.env
    const invocation = hostInvocation(request, env)
    try {
      const result = await execFileAsync(invocation.command, invocation.args, {
        cwd: request.workingDirectory,
        maxBuffer: maxOutputBytes,
        env,
        timeout: request.timeoutMs,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
        errno?: number
        signal?: NodeJS.Signals | string
        killed?: boolean
      }
      const stdout = limitOutput(err.stdout ?? '', maxOutputBytes)
      const stderrSource = err.stderr && Buffer.byteLength(err.stderr) > 0
        ? err.stderr
        : safeChildProcessErrorMessage(err)
      const stderr = limitOutput(stderrSource, maxOutputBytes)
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
