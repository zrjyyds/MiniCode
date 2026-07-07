import path from 'node:path'
import type {
  DockerResourceLimits,
  DockerRunSpec,
  DockerSandboxConfig,
} from './types.js'
import { SandboxExecutionError } from './errors.js'

export const DEFAULT_DOCKER_IMAGE = 'minicode-sandbox:phase5'

export const DEFAULT_DOCKER_RESOURCES: DockerResourceLimits = {
  cpus: '1',
  memory: '256m',
  memorySwap: '256m',
  pidsLimit: 64,
  nofile: '256:256',
  tmpfsSize: '64m',
}

export function defaultDockerSandboxConfig(runtimeRoot = path.resolve('..', 'outputs', 'phase-5-docker-sandbox', 'runtime')): DockerSandboxConfig {
  return {
    image: process.env.MINI_CODE_SANDBOX_IMAGE ?? DEFAULT_DOCKER_IMAGE,
    runtimeRoot,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    defaultOutputBytes: 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
    snapshotMaxBytes: 20 * 1024 * 1024,
    snapshotMaxFiles: 5_000,
    resources: DEFAULT_DOCKER_RESOURCES,
    user: '10001:10001',
  }
}

export function sanitizeRunId(runId: string): string {
  const safe = runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 48) || 'run'
}

export function buildDockerRunSpec(args: {
  config: DockerSandboxConfig
  runId: string
  workspacePath: string
  command: string
  environment?: Record<string, string | undefined>
  faultInjection?: 'omit-network-none'
}): DockerRunSpec {
  const containerName = `minicode-sandbox-${sanitizeRunId(args.runId)}`
  const env = allowedSandboxEnvironment(args.environment ?? {})
  const dockerArgs = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    args.faultInjection === 'omit-network-none' ? 'bridge' : 'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    args.config.user,
    '--read-only',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${args.config.resources.tmpfsSize}`,
    '--cpus',
    args.config.resources.cpus,
    '--memory',
    args.config.resources.memory,
    '--memory-swap',
    args.config.resources.memorySwap,
    '--pids-limit',
    String(args.config.resources.pidsLimit),
    '--ulimit',
    `nofile=${args.config.resources.nofile}`,
    '--workdir',
    '/workspace',
    '--mount',
    `type=bind,src=${args.workspacePath},dst=/workspace,rw`,
  ]

  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('--env', `${key}=${value}`)
  }

  dockerArgs.push(args.config.image, '/bin/sh', '-lc', args.command)

  return {
    args: dockerArgs,
    containerName,
    image: args.config.image,
    workspacePath: args.workspacePath,
    command: args.command,
    security: {
      network_mode: args.faultInjection === 'omit-network-none' ? 'bridge' : 'none',
      read_only_rootfs: true,
      user: args.config.user,
      cap_drop: ['ALL'],
      no_new_privileges: true,
      cpu_limit: args.config.resources.cpus,
      memory_limit: args.config.resources.memory,
      pids_limit: args.config.resources.pidsLimit,
      output_limit: args.config.defaultOutputBytes,
    },
  }
}

export function allowedSandboxEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const allowedKeys = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'MINI_CODE_SANDBOX'])
  const defaults: Record<string, string> = {
    HOME: '/home/minicode',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    MINI_CODE_SANDBOX: '1',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }
  const next = { ...defaults }
  for (const [key, value] of Object.entries(source)) {
    if (allowedKeys.has(key) && value != null) {
      next[key] = value
    }
  }
  return next
}

export function validateDockerRunArgs(args: string[], allowedMountRoot?: string): void {
  const joined = args.join('\n')
  const forbidden = [
    '--privileged',
    '--network host',
    '--pid host',
    '--ipc host',
    '--uts host',
    '--userns host',
    '--cap-add',
    '/var/run/docker.sock',
    '.ssh',
    '.docker',
  ]
  for (const marker of forbidden) {
    if (joined.includes(marker)) {
      throw new SandboxExecutionError('SECURITY_POLICY_DENIED', `Forbidden Docker argument detected: ${marker}`)
    }
  }

  const requiredPairs = [
    ['--network', 'none'],
    ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'],
    ['--read-only'],
    ['--cpus'],
    ['--memory'],
    ['--memory-swap'],
    ['--pids-limit'],
    ['--ulimit'],
    ['--user'],
  ]
  for (const pair of requiredPairs) {
    const index = args.indexOf(pair[0]!)
    if (index < 0 || (pair[1] && args[index + 1] !== pair[1])) {
      throw new SandboxExecutionError('SECURITY_POLICY_DENIED', `Missing required Docker safety option: ${pair.join(' ')}`)
    }
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--mount') continue
    const mount = args[i + 1] ?? ''
    const src = /(?:^|,)src=([^,]+)/.exec(mount)?.[1]
    if (!src) {
      throw new SandboxExecutionError('SECURITY_POLICY_DENIED', 'Docker mount is missing src')
    }
    if (allowedMountRoot) {
      const relative = path.relative(path.resolve(allowedMountRoot), path.resolve(src))
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new SandboxExecutionError('SECURITY_POLICY_DENIED', `Mount escapes allowed root: ${src}`)
      }
    }
  }
}
