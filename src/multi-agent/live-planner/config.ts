import { readFile } from 'node:fs/promises'
import type {
  LiveModelBudget,
  PlannerBenchmarkConfig,
  PlannerEnvironmentStatus,
  PlannerLiveConfig,
  PlannerLiveProviderConfig,
  ResolvedPlannerModel,
} from './types.js'

const PROVIDER_TYPES = new Set(['anthropic-compatible', 'fake'])

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

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, label)
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function validateBenchmark(value: unknown): PlannerBenchmarkConfig {
  assertObject(value, 'benchmark')
  return {
    repetitions: requireNumber(value.repetitions, 'benchmark.repetitions'),
    temperature: requireNumber(value.temperature, 'benchmark.temperature'),
    maxOutputTokens: requireNumber(value.maxOutputTokens, 'benchmark.maxOutputTokens'),
    requestTimeoutMs: requireNumber(value.requestTimeoutMs, 'benchmark.requestTimeoutMs'),
    maxRequests: requireNumber(value.maxRequests, 'benchmark.maxRequests'),
    maxTotalInputTokens: requireNumber(value.maxTotalInputTokens, 'benchmark.maxTotalInputTokens'),
    maxTotalOutputTokens: requireNumber(value.maxTotalOutputTokens, 'benchmark.maxTotalOutputTokens'),
    maxFailures: value.maxFailures === undefined ? 10 : requireNumber(value.maxFailures, 'benchmark.maxFailures'),
    maxConsecutiveFailures: value.maxConsecutiveFailures === undefined ? 3 : requireNumber(value.maxConsecutiveFailures, 'benchmark.maxConsecutiveFailures'),
    maxTotalDurationMs: value.maxTotalDurationMs === undefined ? 10 * 60_000 : requireNumber(value.maxTotalDurationMs, 'benchmark.maxTotalDurationMs'),
    maxRepairAttempts: value.maxRepairAttempts === undefined ? 1 : requireNumber(value.maxRepairAttempts, 'benchmark.maxRepairAttempts'),
  }
}

function validateProvider(value: unknown): PlannerLiveProviderConfig {
  assertObject(value, 'provider')
  const type = requireString(value.type, 'provider.type')
  if (!PROVIDER_TYPES.has(type)) {
    throw new Error(`Unknown planner provider type: ${type}`)
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error('provider.models must contain at least one model')
  }
  const seenModels = new Set<string>()
  const models = value.models.map(modelValue => {
    assertObject(modelValue, 'provider.model')
    const id = requireString(modelValue.id, 'model.id')
    if (seenModels.has(id)) {
      throw new Error(`Duplicate model id in provider: ${id}`)
    }
    seenModels.add(id)
    return {
      id,
      model: requireString(modelValue.model, 'model.model'),
      enabled: bool(modelValue.enabled, true),
      pricing: modelValue.pricing && typeof modelValue.pricing === 'object'
        ? modelValue.pricing
        : undefined,
    }
  })
  return {
    id: requireString(value.id, 'provider.id'),
    type: type as PlannerLiveProviderConfig['type'],
    baseUrlEnv: optionalString(value.baseUrlEnv, 'provider.baseUrlEnv'),
    authTokenEnv: optionalString(value.authTokenEnv, 'provider.authTokenEnv'),
    models,
  }
}

export function validatePlannerLiveConfig(value: unknown): PlannerLiveConfig {
  assertObject(value, 'planner live config')
  if (value.schemaVersion !== '1.0') {
    throw new Error('planner live config schemaVersion must be 1.0')
  }
  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error('providers must contain at least one provider')
  }
  const providers = value.providers.map(validateProvider)
  const seenProviders = new Set<string>()
  for (const provider of providers) {
    if (seenProviders.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`)
    }
    seenProviders.add(provider.id)
  }
  return {
    schemaVersion: '1.0',
    providers,
    benchmark: validateBenchmark(value.benchmark),
  }
}

export async function loadPlannerLiveConfig(configPath: string): Promise<PlannerLiveConfig> {
  return validatePlannerLiveConfig(JSON.parse(await readFile(configPath, 'utf8')))
}

export function toLiveModelBudget(config: PlannerBenchmarkConfig): LiveModelBudget {
  return {
    maxRequests: config.maxRequests,
    maxInputTokens: config.maxTotalInputTokens,
    maxOutputTokens: config.maxTotalOutputTokens,
    maxTotalTokens: config.maxTotalInputTokens + config.maxTotalOutputTokens,
    maxFailures: config.maxFailures ?? 10,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
    maxTotalDurationMs: config.maxTotalDurationMs ?? 10 * 60_000,
  }
}

export function environmentStatusForProvider(provider: PlannerLiveProviderConfig): PlannerEnvironmentStatus {
  return {
    providerId: provider.id,
    baseUrlEnv: provider.baseUrlEnv,
    baseUrlPresent: provider.type === 'fake' || Boolean(provider.baseUrlEnv && process.env[provider.baseUrlEnv]),
    authTokenEnv: provider.authTokenEnv,
    authTokenPresent: provider.type === 'fake' || Boolean(provider.authTokenEnv && process.env[provider.authTokenEnv]),
  }
}

export function resolvePlannerModels(config: PlannerLiveConfig): ResolvedPlannerModel[] {
  const resolved: ResolvedPlannerModel[] = []
  for (const provider of config.providers) {
    const status = environmentStatusForProvider(provider)
    const environmentAvailable = provider.type === 'fake' || (status.baseUrlPresent && status.authTokenPresent)
    for (const model of provider.models.filter(item => item.enabled)) {
      resolved.push({
        provider,
        model,
        baseUrl: provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined,
        authToken: provider.authTokenEnv ? process.env[provider.authTokenEnv] : undefined,
        environmentAvailable,
        unavailableCode: environmentAvailable ? undefined : 'LIVE_ENVIRONMENT_UNAVAILABLE',
        environmentStatus: status,
      })
    }
  }
  return resolved
}

export function assertConfigContainsNoSecrets(config: PlannerLiveConfig): void {
  const raw = JSON.stringify(config)
  const suspicious = [/sk-[A-Za-z0-9_-]+/, /Bearer\s+[A-Za-z0-9._-]+/, /api[_-]?key/i]
  if (suspicious.some(pattern => pattern.test(raw))) {
    throw new Error('Planner live config appears to contain a secret value.')
  }
}
