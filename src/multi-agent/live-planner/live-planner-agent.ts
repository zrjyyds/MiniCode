import { randomUUID } from 'node:crypto'
import { PlannerOutputParseError, parsePlannerOutput } from '../planner-output-parser.js'
import { PlanValidator } from '../plan-validator.js'
import type { PlannerAgent, PlannerRequest, ReplanRequest, TaskPlan } from '../types.js'
import {
  PLANNER_PROMPT_ID,
  PLANNER_PROMPT_VERSION,
  PLANNER_REPAIR_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  TASK_PLAN_JSON_SCHEMA,
  plannerPromptHash,
} from '../prompts/planner-v1.js'
import { LiveModelBudgetExceededError, LiveModelBudgetTracker } from './budget.js'
import type {
  LivePlannerResult,
  PlannerModelAdapter,
  PlannerModelRequest,
  PlannerModelResponse,
  PlannerTraceEvent,
} from './types.js'

export type LivePlannerAgentOptions = {
  adapter: PlannerModelAdapter
  providerId: string
  modelId: string
  model: string
  temperature: number
  maxOutputTokens: number
  timeoutMs: number
  registeredTools: string[]
  forbiddenTools?: string[]
  maxRepairAttempts?: number
  budgetTracker: LiveModelBudgetTracker
  trace?: (event: PlannerTraceEvent) => void | Promise<void>
}

function preview(value: string, limit = 1200): string {
  const sanitized = value
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, limit)}...`
}

function codeOf(error: unknown): string {
  if (error instanceof PlannerOutputParseError) return error.code
  if (error instanceof LiveModelBudgetExceededError) return 'LIVE_MODEL_BUDGET_EXCEEDED'
  return 'PLANNER_REQUEST_FAILED'
}

export class LivePlannerAgent implements PlannerAgent {
  readonly results: LivePlannerResult[] = []

  constructor(private readonly options: LivePlannerAgentOptions) {}

  async createPlan(request: PlannerRequest): Promise<TaskPlan> {
    return this.runPlanner(request)
  }

  async revisePlan(request: ReplanRequest): Promise<TaskPlan> {
    return this.runPlanner(request)
  }

  private async emit(event: Omit<PlannerTraceEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    await this.options.trace?.({
      provider_id: this.options.providerId,
      model_id: this.options.modelId,
      prompt_version: PLANNER_PROMPT_VERSION,
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })
  }

  private buildRequest(
    plannerContext: PlannerRequest | ReplanRequest,
    requestId: string,
    attempt: number,
    repair?: PlannerModelRequest['repair'],
  ): PlannerModelRequest {
    return {
      systemPrompt: repair ? `${PLANNER_SYSTEM_PROMPT}\n\n${PLANNER_REPAIR_PROMPT}` : PLANNER_SYSTEM_PROMPT,
      plannerContext,
      taskPlanSchema: TASK_PLAN_JSON_SCHEMA,
      providerId: this.options.providerId,
      modelId: this.options.modelId,
      model: this.options.model,
      temperature: this.options.temperature,
      maxOutputTokens: this.options.maxOutputTokens,
      timeoutMs: this.options.timeoutMs,
      requestId,
      attempt,
      promptId: PLANNER_PROMPT_ID,
      promptVersion: PLANNER_PROMPT_VERSION,
      promptHash: plannerPromptHash(),
      repair,
    }
  }

  private validate(plan: TaskPlan): string[] {
    return new PlanValidator({
      registeredTools: this.options.registeredTools,
      forbiddenTools: this.options.forbiddenTools,
      maxSteps: 10,
    }).validate(plan)
  }

  private async requestModel(modelRequest: PlannerModelRequest): Promise<PlannerModelResponse> {
    this.options.budgetTracker.assertCanRequest()
    this.options.budgetTracker.recordRequest()
    await this.emit({
      event_type: 'planner_live_request_started',
      request_id: modelRequest.requestId,
      attempt: modelRequest.attempt,
    })
    try {
      const response = await this.options.adapter.generatePlan(modelRequest)
      this.options.budgetTracker.recordSuccess(response.usage)
      await this.emit({
        event_type: 'planner_live_response_received',
        request_id: response.requestId,
        attempt: response.attempt,
        latency_ms: response.latencyMs,
        finish_reason: response.finishReason,
        input_tokens: response.usage?.inputTokens,
        output_tokens: response.usage?.outputTokens,
      })
      return response
    } catch (error) {
      this.options.budgetTracker.recordFailure()
      await this.emit({
        event_type: 'planner_live_request_failed',
        request_id: modelRequest.requestId,
        attempt: modelRequest.attempt,
        error_code: codeOf(error),
        error_message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async parseValidateRecord(response: PlannerModelResponse, repairUsed: boolean): Promise<LivePlannerResult> {
    await this.emit({
      event_type: 'planner_live_parse_started',
      request_id: response.requestId,
      attempt: response.attempt,
      repair_used: repairUsed,
    })
    try {
      const parsed = parsePlannerOutput(response.rawText)
      const errors = this.validate(parsed.plan)
      const ok = errors.length === 0
      await this.emit({
        event_type: 'planner_live_validation_completed',
        request_id: response.requestId,
        attempt: response.attempt,
        parse_status: 'passed',
        validation_status: ok ? 'passed' : 'failed',
        repair_used: repairUsed,
        error_code: ok ? undefined : 'PLANNER_PLAN_REJECTED',
      })
      return {
        plan: ok ? parsed.plan : undefined,
        providerId: response.providerId,
        modelId: response.modelId,
        requestId: response.requestId,
        parseStatus: 'passed',
        validation: { ok, errors },
        repairUsed,
        errorCode: ok ? undefined : 'PLANNER_PLAN_REJECTED',
        errorMessage: ok ? undefined : errors.join('; '),
        response,
      }
    } catch (error) {
      const errorCode = codeOf(error)
      await this.emit({
        event_type: 'planner_live_parse_failed',
        request_id: response.requestId,
        attempt: response.attempt,
        parse_status: 'failed',
        repair_used: repairUsed,
        error_code: errorCode,
        error_message: error instanceof Error ? error.message : String(error),
      })
      return {
        providerId: response.providerId,
        modelId: response.modelId,
        requestId: response.requestId,
        parseStatus: 'failed',
        validation: { ok: false, errors: [error instanceof Error ? error.message : String(error)] },
        repairUsed,
        errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
        response,
      }
    }
  }

  private async runPlanner(plannerContext: PlannerRequest | ReplanRequest): Promise<TaskPlan> {
    const requestId = randomUUID()
    try {
      const firstResponse = await this.requestModel(this.buildRequest(plannerContext, requestId, 1))
      const first = await this.parseValidateRecord(firstResponse, false)
      this.results.push(first)
      if (first.plan) return first.plan

      if ((this.options.maxRepairAttempts ?? 1) <= 0) {
        throw new Error(first.errorMessage ?? 'Planner output rejected')
      }

      await this.emit({
        event_type: 'planner_repair_requested',
        request_id: requestId,
        attempt: 2,
        repair_used: true,
        error_code: first.errorCode,
      })
      const repairResponse = await this.requestModel(this.buildRequest(plannerContext, requestId, 2, {
        errors: first.validation.errors,
        previousResponsePreview: preview(firstResponse.rawText),
      }))
      const repaired = await this.parseValidateRecord(repairResponse, true)
      this.results.push(repaired)
      await this.emit({
        event_type: 'planner_repair_completed',
        request_id: requestId,
        attempt: 2,
        repair_used: true,
        validation_status: repaired.validation.ok ? 'passed' : 'failed',
        error_code: repaired.errorCode,
      })
      if (repaired.plan) return repaired.plan
      throw new Error(repaired.errorMessage ?? 'Planner repair rejected')
    } catch (error) {
      if (error instanceof LiveModelBudgetExceededError) {
        await this.emit(this.options.budgetTracker.budgetExceededEvent(error.reason))
      }
      throw error
    }
  }
}
