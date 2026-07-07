import path from 'node:path'
import { DockerSandboxExecutor } from './docker-sandbox-executor.js'
import { defaultDockerSandboxConfig } from './docker-command-builder.js'
import { HostCommandExecutor } from './host-command-executor.js'
import type { CommandExecutor, DockerCliRunner } from './types.js'

export type CommandExecutorName = 'host' | 'docker'

export function selectCommandExecutorName(value = process.env.MINI_CODE_COMMAND_EXECUTOR ?? 'host'): CommandExecutorName {
  if (value === 'host' || value === '') return 'host'
  if (value === 'docker') return 'docker'
  throw new Error(`Unknown command executor: ${value}`)
}

export function createCommandExecutor(args: {
  name?: string
  runtimeRoot?: string
  dockerRunner?: DockerCliRunner
} = {}): CommandExecutor {
  const name = selectCommandExecutorName(args.name)
  if (name === 'host') {
    return new HostCommandExecutor()
  }
  const runtimeRoot = args.runtimeRoot ?? path.resolve('..', 'outputs', 'phase-5-docker-sandbox', 'runtime')
  return new DockerSandboxExecutor(defaultDockerSandboxConfig(runtimeRoot), args.dockerRunner)
}

export { DockerSandboxExecutor } from './docker-sandbox-executor.js'
export { HostCommandExecutor } from './host-command-executor.js'
export type * from './types.js'
