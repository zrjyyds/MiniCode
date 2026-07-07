import { randomUUID } from 'node:crypto'
import type { ToolRegistry } from '../tool.js'
import { MultiAgentError, messageOf } from './errors.js'
import { ExecutorContextBuilder, PlannerContextBuilder, summarizeCompletedSteps } from './context-builder.js'
import { PlanValidator, toolNamesFromRegistry } from './plan-validator.js'
import { MockExecutorAgent } from './executor.js'
import { MockPlannerAgent } from './planner.js'
import { RuleBasedReviewer } from './reviewer.js'
import { StepScheduler } from './scheduler.js'
import { MultiAgentStateStore, markInterruptedSteps } from './state-store.js'
import type {
  DeterministicReviewer,
  ExecutorAgent,
  MultiAgentBudgets,
  MultiAgentRunState,
  MultiAgentStatus,
  PlannerAgent,
  StepExecutionResult,
  TaskPlan,
} from './types.js'
import { MULTI_AGENT_SCHEMA_VERSION, defaultMultiAgentBudgets } from './types.js'

const ALLOWED_TRANSITIONS: Record<MultiAgentStatus, MultiAgentStatus[]> = {
  created: ['planning', 'cancelled'],
  planning: ['validating_plan', 'failed', 'budget_exceeded'],
  validating_plan: ['ready', 'failed', 'budget_exceeded'],
  ready: ['executing_step', 'reviewing', 'blocked', 'budget_exceeded'],
  executing_step: ['reviewing_step', 'failed', 'budget_exceeded'],
  reviewing_step: ['step_completed', 'replanning', 'ready', 'failed', 'budget_exceeded'],
  step_completed: ['ready', 'executing_step', 'reviewing', 'budget_exceeded'],
  replanning: ['validating_plan', 'failed', 'budget_exceeded'],
  reviewing: ['completed', 'failed', 'budget_exceeded'],
  completed: [],
  failed: [],
  blocked: [],
  cancelled: [],
  budget_exceeded: [],
}

export type MultiAgentOrchestratorOptions = {
  objective: string
  cwd: string
  outputDir: string
  tools: ToolRegistry
  scenario?: string
  planner?: PlannerAgent
  executor?: ExecutorAgent
  reviewer?: DeterministicReviewer
  budgets?: Partial<MultiAgentBudgets>
  injectFailure?: string
  stopAfterSteps?: number
  resume?: string
}

export class MultiAgentOrchestrator {
  private readonly planner: PlannerAgent
  private readonly executor: ExecutorAgent
  private readonly reviewer: DeterministicReviewer
  private readonly scheduler = new StepScheduler()
  private readonly plannerContext = new PlannerContextBuilder()
  private readonly executorContext = new ExecutorContextBuilder()
  private readonly store: MultiAgentStateStore
  private readonly budgets: MultiAgentBudgets
  private state?: MultiAgentRunState
  private executedStepsThisRun = 0

  constructor(private readonly options: MultiAgentOrchestratorOptions) {
    this.planner = options.planner ?? new MockPlannerAgent()
    this.executor = options.executor ?? new MockExecutorAgent()
    this.reviewer = options.reviewer ?? new RuleBasedReviewer()
    this.store = new MultiAgentStateStore(options.outputDir)
    this.budgets = { ...defaultMultiAgentBudgets(), ...options.budgets }
  }

  async run(): Promise<MultiAgentRunState> {
    if (this.options.resume) {
      this.state = markInterruptedSteps(await this.store.loadState(this.options.resume))
      await this.store.validateArtifacts(this.state)
      await this.emit('run_resumed', { state_after: this.state.status })
      await this.checkpoint('run_resumed')
    } else {
      this.state = this.createInitialState()
      await this.store.initRun(this.state.runId)
      await this.emit('multi_agent_run_started', { state_after: this.state.status })
    }

    if (!this.state.currentPlan.steps.length) {
      await this.plan()
    }

    while (!['completed', 'failed', 'blocked', 'cancelled', 'budget_exceeded'].includes(this.state.status)) {
      if (this.options.stopAfterSteps && this.executedStepsThisRun >= this.options.stopAfterSteps) {
        await this.checkpoint('simulated_interrupt')
        break
      }
      if (this.isBudgetExceeded()) {
        await this.transition('budget_exceeded', 'budget exceeded')
        await this.emit('multi_agent_budget_exceeded', { termination_reason: this.state.terminationReason })
        await this.checkpoint('budget_exceeded')
        break
      }
      if (this.state.status === 'ready' || this.state.status === 'step_completed') {
        const schedule = this.scheduler.schedule(this.state)
        await this.emit('step_scheduled', {
          step_id: schedule.selectedStep?.id,
          ready_steps: schedule.readySteps.map(step => step.id),
          blocked_steps: schedule.blockedSteps.map(step => step.id),
        })
        if (!schedule.selectedStep) {
          if (schedule.completedSteps.length === this.state.currentPlan.steps.length) {
            await this.reviewTask()
          } else {
            await this.transition('blocked', schedule.reason)
            await this.emit('multi_agent_run_failed', { termination_reason: schedule.reason })
            await this.checkpoint('blocked')
          }
          continue
        }
        await this.executeStep(schedule.selectedStep.id)
        continue
      }
      if (this.state.status === 'validating_plan') {
        await this.validatePlan()
        continue
      }
      if (this.state.status === 'planning') {
        await this.plan()
        continue
      }
      if (this.state.status === 'replanning') {
        await this.replan()
        continue
      }
      await this.transition('failed', `Unhandled state: ${this.state.status}`)
    }
    return this.state
  }

  private createInitialState(): MultiAgentRunState {
    const emptyPlan: TaskPlan = {
      schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
      planId: 'unplanned',
      objective: this.options.objective,
      assumptions: [],
      constraints: [],
      successCriteria: [],
      steps: [],
      createdAt: new Date().toISOString(),
      revision: 0,
    }
    return {
      schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
      runId: randomUUID(),
      objective: this.options.objective,
      status: 'planning',
      currentPlan: emptyPlan,
      planHistory: [],
      stepResults: {},
      plannerCalls: 0,
      executorCalls: 0,
      toolCalls: 0,
      replanCount: 0,
      budgets: this.budgets,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  private async plan(): Promise<void> {
    this.requireState('planning')
    if (this.state!.plannerCalls >= this.state!.budgets.maxPlannerCalls) {
      await this.transition('budget_exceeded', 'planner call budget exceeded')
      return
    }
    await this.emit('planner_request_started')
    const request = this.plannerContext.build({
      objective: this.state!.objective,
      constraints: ['offline', 'no network', 'no real MCP'],
      tools: this.options.tools.list().map(tool => ({ name: tool.name, description: tool.description })),
      budgets: this.state!.budgets,
      scenario: this.options.scenario,
    })
    this.state!.plannerCalls += 1
    this.state!.currentPlan = await this.planner.createPlan(request)
    this.state!.planHistory = [this.state!.currentPlan]
    await this.emit('planner_response_received', {
      plan_id: this.state!.currentPlan.planId,
      plan_revision: this.state!.currentPlan.revision,
    })
    await this.checkpoint('plan_generated')
    await this.transition('validating_plan')
  }

  private async validatePlan(): Promise<void> {
    this.requireState('validating_plan')
    await this.emit('plan_validation_started')
    try {
      new PlanValidator({
        registeredTools: [...toolNamesFromRegistry(this.options.tools), 'none'],
        maxSteps: this.state!.budgets.maxPlanSteps,
      }).validateOrThrow(this.state!.currentPlan)
      await this.emit('plan_accepted', {
        plan_id: this.state!.currentPlan.planId,
        plan_revision: this.state!.currentPlan.revision,
      })
      await this.transition('ready')
      await this.checkpoint('plan_validated')
    } catch (error) {
      await this.emit('plan_rejected', {
        failure_stage: 'PLAN_VALIDATION',
        error_message: messageOf(error),
      })
      await this.transition('failed', messageOf(error))
      await this.checkpoint('plan_rejected')
    }
  }

  private async executeStep(stepId: string): Promise<void> {
    await this.transition('executing_step')
    const step = this.state!.currentPlan.steps.find(item => item.id === stepId)
    if (!step) throw new Error(`Unknown step: ${stepId}`)
    const previousAttempts = this.state!.stepResults[stepId]?.attempt ?? 0
    const attempt = previousAttempts + 1
    this.state!.currentStepId = stepId
    this.state!.executorCalls += 1
    await this.emit('executor_step_started', { step_id: stepId, step_attempt: attempt })
    await this.checkpoint('step_started')
    const request = this.executorContext.build({
      state: this.state!,
      stepId,
      cwd: this.options.cwd,
      attempt,
      scenario: this.options.scenario,
      injectFailure: this.options.injectFailure,
    })
    const result = await this.executor.executeStep(request)
    this.state!.toolCalls += result.toolCalls.length
    this.state!.stepResults[stepId] = result
    this.executedStepsThisRun += 1
    await this.emit('executor_step_completed', {
      step_id: stepId,
      step_attempt: attempt,
      tool_call_count: this.state!.toolCalls,
      status: result.status,
    })
    await this.transition('reviewing_step')
    await this.reviewStep(stepId, result)
  }

  private async reviewStep(stepId: string, result: StepExecutionResult): Promise<void> {
    const step = this.state!.currentPlan.steps.find(item => item.id === stepId)!
    await this.emit('step_review_started', { step_id: stepId, step_attempt: result.attempt })
    const review = await this.reviewer.reviewStep({
      plan: this.state!.currentPlan,
      step,
      result,
    })
    this.state!.stepResults[stepId] = {
      ...result,
      status: review.status === 'passed' ? 'completed' : 'failed',
      reviewerAssertions: review.assertions,
      failureStage: review.failureStage ?? result.failureStage,
      errorCode: review.errorCode ?? result.errorCode,
    }
    await this.emit('step_review_completed', {
      step_id: stepId,
      step_attempt: result.attempt,
      status: review.status,
      failure_stage: review.failureStage,
    })
    await this.checkpoint(review.status === 'passed' ? 'step_completed' : 'step_failed')
    if (review.status === 'passed') {
      this.state!.currentStepId = undefined
      await this.transition('step_completed')
      return
    }
    if (result.attempt < step.maxAttempts) {
      this.state!.stepResults[stepId] = {
        ...this.state!.stepResults[stepId]!,
        status: 'interrupted',
      }
      await this.emit('step_retry_scheduled', { step_id: stepId, step_attempt: result.attempt + 1 })
      await this.transition('ready', 'retry step')
      await this.checkpoint('retry_scheduled')
      return
    }
    if (this.state!.replanCount < this.state!.budgets.maxReplans) {
      await this.emit('replan_requested', {
        step_id: stepId,
        failure_stage: String(review.failureStage ?? 'STEP_FAILED'),
      })
      await this.transition('replanning')
      return
    }
    await this.transition('budget_exceeded', 'max replans exceeded')
    await this.emit('multi_agent_budget_exceeded', { termination_reason: this.state!.terminationReason })
    await this.checkpoint('max_replans_exceeded')
  }

  private async replan(): Promise<void> {
    this.requireState('replanning')
    if (this.state!.plannerCalls >= this.state!.budgets.maxPlannerCalls) {
      await this.transition('budget_exceeded', 'planner call budget exceeded')
      return
    }
    const failed = Object.values(this.state!.stepResults).find(result => result.status === 'failed')
    if (!failed) {
      await this.transition('failed', 'replan requested without failed step')
      return
    }
    this.state!.plannerCalls += 1
    this.state!.replanCount += 1
    const request = {
      ...this.plannerContext.build({
        objective: this.state!.objective,
        constraints: ['offline', 'no network'],
        tools: this.options.tools.list().map(tool => ({ name: tool.name, description: tool.description })),
        budgets: this.state!.budgets,
        scenario: this.options.scenario,
      }),
      previousPlan: this.state!.currentPlan,
      failure: {
        failedStepId: failed.stepId,
        failureStage: String(failed.failureStage ?? 'STEP_FAILED'),
        errorCode: failed.errorCode,
        errorSummary: (failed.errorMessage ?? 'step failed').slice(0, 300),
        attempts: failed.attempt,
        completedSteps: summarizeCompletedSteps(this.state!),
        remainingBudget: this.state!.budgets,
      },
    }
    const nextPlan = await this.planner.revisePlan(request)
    if (nextPlan.revision <= this.state!.currentPlan.revision) {
      await this.transition('failed', 'revised plan revision did not increase')
      return
    }
    this.state!.currentPlan = nextPlan
    this.state!.planHistory = [...this.state!.planHistory, nextPlan]
    for (const [id, stepResult] of Object.entries(this.state!.stepResults)) {
      if (stepResult.status === 'failed') {
        delete this.state!.stepResults[id]
      }
    }
    await this.emit('replan_completed', {
      plan_id: nextPlan.planId,
      plan_revision: nextPlan.revision,
      replan_count: this.state!.replanCount,
    })
    await this.checkpoint('replan_completed')
    await this.transition('validating_plan')
  }

  private async reviewTask(): Promise<void> {
    await this.transition('reviewing')
    await this.emit('task_review_started')
    const review = await this.reviewer.reviewTask({ state: this.state! })
    await this.emit('task_review_completed', {
      status: review.status,
      failure_stage: review.failureStage,
    })
    if (review.status === 'passed') {
      await this.transition('completed', 'task completed')
      await this.emit('multi_agent_run_completed', { termination_reason: this.state!.terminationReason })
    } else {
      await this.transition('failed', review.errorCode ?? 'task review failed')
      await this.emit('multi_agent_run_failed', { termination_reason: this.state!.terminationReason })
    }
    await this.checkpoint('task_reviewed')
  }

  private isBudgetExceeded(): boolean {
    const state = this.state!
    return (
      state.plannerCalls > state.budgets.maxPlannerCalls ||
      state.executorCalls > state.budgets.maxExecutorCalls ||
      state.toolCalls > state.budgets.maxToolCalls ||
      state.replanCount > state.budgets.maxReplans ||
      Date.now() - Date.parse(state.createdAt) > state.budgets.maxTotalDurationMs
    )
  }

  private async checkpoint(reason: string): Promise<void> {
    this.state!.updatedAt = new Date().toISOString()
    await this.store.saveState(this.state!)
    await this.emit('checkpoint_saved', { reason, state_after: this.state!.status })
  }

  private async emit(event_type: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.state) return
    await this.store.appendTrace(this.state.runId, {
      event_type,
      plan_id: this.state.currentPlan.planId,
      plan_revision: this.state.currentPlan.revision,
      planner_call_count: this.state.plannerCalls,
      executor_call_count: this.state.executorCalls,
      tool_call_count: this.state.toolCalls,
      replan_count: this.state.replanCount,
      ...extra,
    })
  }

  private requireState(status: MultiAgentStatus): void {
    if (this.state!.status !== status) {
      throw new MultiAgentError('INVALID_STATE_TRANSITION', `Expected ${status}, got ${this.state!.status}`)
    }
  }

  private async transition(next: MultiAgentStatus, reason?: string): Promise<void> {
    const before = this.state!.status
    if (!ALLOWED_TRANSITIONS[before].includes(next)) {
      throw new MultiAgentError('INVALID_STATE_TRANSITION', `${before} -> ${next}`)
    }
    this.state!.status = next
    this.state!.updatedAt = new Date().toISOString()
    if (reason) {
      this.state!.terminationReason = reason
    }
    await this.emit('state_transition', {
      state_before: before,
      state_after: next,
      termination_reason: reason,
    })
  }
}

export { ALLOWED_TRANSITIONS }
