import type { PlannerRequest, ReplanRequest, TaskPlan } from '../types.js'

export type LivePlannerProviderType = 'anthropic-compatible' | 'fake'

export type PlannerUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
}

export type PlannerModelRequest = {
  systemPrompt: string
  plannerContext: PlannerRequest | ReplanRequest | Record<string, unknown>
  taskPlanSchema: unknown
  providerId: string
  modelId: string
  model: string
  temperature: number
  maxOutputTokens: number
  timeoutMs: number
  requestId: string
  attempt: number
  promptId: string
  promptVersion: string
  promptHash: string
  repair?: {
    errors: string[]
    previousResponsePreview: string
  }
}

export type PlannerModelResponse = {
  providerId: string
  modelId: string
  rawText: string
  finishReason?: string
  usage?: PlannerUsage
  latencyMs: number
  requestId: string
  attempt: number
  cacheHit?: boolean
}

export type PlannerModelAdapter = {
  generatePlan(request: PlannerModelRequest): Promise<PlannerModelResponse>
}

export type PlannerPricing = {
  inputPerMillion?: number
  outputPerMillion?: number
  cachedInputPerMillion?: number
  currency?: string
  sourceNote?: string
}

export type PlannerLiveModelConfig = {
  id: string
  model: string
  enabled: boolean
  pricing?: PlannerPricing
}

export type PlannerLiveProviderConfig = {
  id: string
  type: LivePlannerProviderType
  baseUrlEnv?: string
  authTokenEnv?: string
  models: PlannerLiveModelConfig[]
}

export type LiveModelBudget = {
  maxRequests: number
  maxInputTokens: number
  maxOutputTokens: number
  maxTotalTokens: number
  maxFailures: number
  maxConsecutiveFailures: number
  maxTotalDurationMs: number
}

export type PlannerBenchmarkConfig = {
  repetitions: number
  temperature: number
  maxOutputTokens: number
  requestTimeoutMs: number
  maxRequests: number
  maxTotalInputTokens: number
  maxTotalOutputTokens: number
  maxFailures?: number
  maxConsecutiveFailures?: number
  maxTotalDurationMs?: number
  maxRepairAttempts?: number
}

export type PlannerLiveConfig = {
  schemaVersion: string
  providers: PlannerLiveProviderConfig[]
  benchmark: PlannerBenchmarkConfig
}

export type PlannerEnvironmentStatus = {
  providerId: string
  baseUrlEnv?: string
  baseUrlPresent: boolean
  authTokenEnv?: string
  authTokenPresent: boolean
}

export type ResolvedPlannerModel = {
  provider: PlannerLiveProviderConfig
  model: PlannerLiveModelConfig
  baseUrl?: string
  authToken?: string
  environmentAvailable: boolean
  unavailableCode?: 'LIVE_ENVIRONMENT_UNAVAILABLE'
  environmentStatus: PlannerEnvironmentStatus
}

export type PlannerValidationResult = {
  ok: boolean
  errors: string[]
}

export type LivePlannerResult = {
  plan?: TaskPlan
  providerId: string
  modelId: string
  requestId: string
  parseStatus: 'passed' | 'failed'
  validation: PlannerValidationResult
  repairUsed: boolean
  errorCode?: string
  errorMessage?: string
  response: PlannerModelResponse
}

export type PlannerTraceEventType =
  | 'planner_live_request_started'
  | 'planner_live_response_received'
  | 'planner_live_parse_started'
  | 'planner_live_parse_failed'
  | 'planner_live_validation_completed'
  | 'planner_repair_requested'
  | 'planner_repair_completed'
  | 'planner_live_request_failed'
  | 'planner_live_budget_exceeded'

export type PlannerTraceEvent = {
  event_type: PlannerTraceEventType
  timestamp: string
  provider_id?: string
  model_id?: string
  prompt_version?: string
  request_id?: string
  attempt?: number
  latency_ms?: number
  finish_reason?: string
  input_tokens?: number
  output_tokens?: number
  parse_status?: 'passed' | 'failed'
  validation_status?: 'passed' | 'failed'
  repair_used?: boolean
  error_code?: string
  error_message?: string
}
