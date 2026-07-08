import type { LiveModelBudget, PlannerTraceEvent, PlannerUsage } from './types.js'

export class LiveModelBudgetExceededError extends Error {
  constructor(readonly reason: string) {
    super(`Live model budget exceeded: ${reason}`)
    this.name = 'LiveModelBudgetExceededError'
  }
}

export type LiveModelBudgetSnapshot = {
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  failures: number
  consecutiveFailures: number
  startedAt: number
  elapsedMs: number
}

export class LiveModelBudgetTracker {
  private requests = 0
  private inputTokens = 0
  private outputTokens = 0
  private failures = 0
  private consecutiveFailures = 0
  private readonly startedAt: number

  constructor(
    private readonly budget: LiveModelBudget,
    private readonly now: () => number = () => Date.now(),
    initial?: Partial<LiveModelBudgetSnapshot>,
  ) {
    this.startedAt = initial?.startedAt ?? this.now()
    this.requests = initial?.requests ?? 0
    this.inputTokens = initial?.inputTokens ?? 0
    this.outputTokens = initial?.outputTokens ?? 0
    this.failures = initial?.failures ?? 0
    this.consecutiveFailures = initial?.consecutiveFailures ?? 0
  }

  assertCanRequest(): void {
    const elapsedMs = this.now() - this.startedAt
    if (this.requests >= this.budget.maxRequests) throw new LiveModelBudgetExceededError('maxRequests')
    if (this.inputTokens >= this.budget.maxInputTokens) throw new LiveModelBudgetExceededError('maxInputTokens')
    if (this.outputTokens >= this.budget.maxOutputTokens) throw new LiveModelBudgetExceededError('maxOutputTokens')
    if (this.inputTokens + this.outputTokens >= this.budget.maxTotalTokens) throw new LiveModelBudgetExceededError('maxTotalTokens')
    if (this.failures >= this.budget.maxFailures) throw new LiveModelBudgetExceededError('maxFailures')
    if (this.consecutiveFailures >= this.budget.maxConsecutiveFailures) throw new LiveModelBudgetExceededError('maxConsecutiveFailures')
    if (elapsedMs >= this.budget.maxTotalDurationMs) throw new LiveModelBudgetExceededError('maxTotalDurationMs')
  }

  recordRequest(): void {
    this.requests += 1
  }

  recordSuccess(usage?: PlannerUsage): void {
    this.inputTokens += usage?.inputTokens ?? 0
    this.outputTokens += usage?.outputTokens ?? 0
    this.consecutiveFailures = 0
  }

  recordFailure(): void {
    this.failures += 1
    this.consecutiveFailures += 1
  }

  snapshot(): LiveModelBudgetSnapshot {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      startedAt: this.startedAt,
      elapsedMs: this.now() - this.startedAt,
    }
  }

  budgetExceededEvent(reason: string): PlannerTraceEvent {
    return {
      event_type: 'planner_live_budget_exceeded',
      timestamp: new Date(this.now()).toISOString(),
      error_code: 'LIVE_MODEL_BUDGET_EXCEEDED',
      error_message: reason,
    }
  }
}
