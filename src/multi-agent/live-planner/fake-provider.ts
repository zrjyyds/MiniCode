import type { PlannerModelAdapter, PlannerModelRequest, PlannerModelResponse, PlannerUsage } from './types.js'

export type FakePlannerProviderStep =
  | string
  | {
      rawText?: string
      status?: number
      error?: string
      timeout?: boolean
      finishReason?: string
      usage?: PlannerUsage
      latencyMs?: number
    }

export class FakePlannerModelAdapter implements PlannerModelAdapter {
  private index = 0

  constructor(private readonly steps: FakePlannerProviderStep[]) {}

  async generatePlan(request: PlannerModelRequest): Promise<PlannerModelResponse> {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)] ?? ''
    this.index += 1
    if (typeof step !== 'string') {
      if (step.timeout) {
        const error = new Error('Fake provider timeout')
        error.name = 'AbortError'
        throw error
      }
      if (step.error || (step.status && step.status >= 400)) {
        throw new Error(step.error ?? `Fake provider failed: ${step.status}`)
      }
    }
    const rawText = typeof step === 'string' ? step : step.rawText ?? ''
    const usage = typeof step === 'string' ? { inputTokens: 10, outputTokens: 20, totalTokens: 30 } : step.usage
    return {
      providerId: request.providerId,
      modelId: request.modelId,
      rawText,
      finishReason: typeof step === 'string' ? 'end_turn' : step.finishReason,
      usage,
      latencyMs: typeof step === 'string' ? 1 : step.latencyMs ?? 1,
      requestId: request.requestId,
      attempt: request.attempt,
    }
  }

  calls(): number {
    return this.index
  }
}
