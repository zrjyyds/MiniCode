import { readFile } from 'node:fs/promises'

export type RealAgentProtocol =
  | 'auto'
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat-completions'

export type RealAgentConfig = {
  schemaVersion: '1.0'
  protocol?: RealAgentProtocol
  stream?: boolean
  streamIncludeUsage?: boolean
  streamToolCallIdPrefix?: string
  baseUrlEnv: string
  apiKeyEnv: string
  modelEnv: string
  requestTimeoutMs: number
  maxOutputTokens: number
  maxRetries: number
  mcpServers?: Record<string, {
    command: string
    args?: string[]
    cwd?: string
    enabled?: boolean
    protocol?: 'auto' | 'content-length' | 'newline-json'
  }>
}

export type ResolvedRealAgentConfig = {
  protocol: RealAgentProtocol
  baseUrl: string
  apiKey: string
  model: string
  requestTimeoutMs: number
  maxOutputTokens: number
  maxRetries: number
  stream: boolean
  streamIncludeUsage: boolean
  streamToolCallIdPrefix?: string
  mcpServers: RealAgentConfig['mcpServers']
  sourcePath: string
}

const VALID_PROTOCOLS = new Set<RealAgentProtocol>([
  'auto',
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
])

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

export function validateRealAgentConfig(value: unknown): RealAgentConfig {
  assertObject(value, 'real agent config')
  if (value.schemaVersion !== '1.0') {
    throw new Error('real agent config schemaVersion must be 1.0')
  }
  const protocol = value.protocol === undefined ? 'auto' : requireString(value.protocol, 'protocol')
  if (!VALID_PROTOCOLS.has(protocol as RealAgentProtocol)) {
    throw new Error(`Unknown real agent provider protocol: ${protocol}`)
  }

  return {
    schemaVersion: '1.0',
    protocol: protocol as RealAgentProtocol,
    stream: optionalBoolean(value.stream, 'stream'),
    streamIncludeUsage: optionalBoolean(value.streamIncludeUsage, 'streamIncludeUsage'),
    streamToolCallIdPrefix: value.streamToolCallIdPrefix === undefined
      ? undefined
      : requireString(value.streamToolCallIdPrefix, 'streamToolCallIdPrefix'),
    baseUrlEnv: requireString(value.baseUrlEnv, 'baseUrlEnv'),
    apiKeyEnv: requireString(value.apiKeyEnv, 'apiKeyEnv'),
    modelEnv: requireString(value.modelEnv, 'modelEnv'),
    requestTimeoutMs: requirePositiveInteger(value.requestTimeoutMs, 'requestTimeoutMs'),
    maxOutputTokens: requirePositiveInteger(value.maxOutputTokens, 'maxOutputTokens'),
    maxRetries: requirePositiveInteger(value.maxRetries, 'maxRetries'),
    mcpServers: value.mcpServers as RealAgentConfig['mcpServers'],
  }
}

export async function loadRealAgentConfig(configPath: string): Promise<RealAgentConfig> {
  return validateRealAgentConfig(JSON.parse(await readFile(configPath, 'utf8')))
}

export function resolveRealAgentConfig(
  config: RealAgentConfig,
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRealAgentConfig {
  const baseUrl = env[config.baseUrlEnv]?.trim()
  const apiKey = env[config.apiKeyEnv]?.trim()
  const model = env[config.modelEnv]?.trim()
  const missing = [
    baseUrl ? '' : config.baseUrlEnv,
    apiKey ? '' : config.apiKeyEnv,
    model ? '' : config.modelEnv,
  ].filter(Boolean)

  if (missing.length > 0) {
    throw new Error(`Missing real agent environment variable(s): ${missing.join(', ')}`)
  }

  return {
    protocol: config.protocol ?? 'auto',
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
    requestTimeoutMs: config.requestTimeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: config.maxRetries,
    stream: config.stream ?? false,
    streamIncludeUsage: config.streamIncludeUsage ?? false,
    streamToolCallIdPrefix: config.streamToolCallIdPrefix,
    mcpServers: config.mcpServers ?? {},
    sourcePath,
  }
}

export function realAgentEnvironmentStatus(config: RealAgentConfig): Record<string, 'present' | 'missing'> {
  return {
    [config.baseUrlEnv]: process.env[config.baseUrlEnv] ? 'present' : 'missing',
    [config.modelEnv]: process.env[config.modelEnv] ? 'present' : 'missing',
    [config.apiKeyEnv]: process.env[config.apiKeyEnv] ? 'present' : 'missing',
  }
}
