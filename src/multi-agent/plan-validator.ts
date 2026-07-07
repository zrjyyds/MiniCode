import type { ToolRegistry } from '../tool.js'
import { MultiAgentError } from './errors.js'
import type { PlanStep, SuccessCriterionType, TaskPlan } from './types.js'

export type PlanValidationOptions = {
  registeredTools: string[]
  forbiddenTools?: string[]
  maxSteps?: number
  maxDependenciesPerStep?: number
  maxCriteriaPerStep?: number
  maxJsonBytes?: number
}

const CRITERION_TYPES = new Set<SuccessCriterionType>([
  'file_exists',
  'file_not_exists',
  'text_contains',
  'text_not_contains',
  'tool_called',
  'tool_not_called',
  'exit_code',
  'trace_event_exists',
  'artifact_exists',
  'json_path_equals',
  'custom_evaluator',
])

export function toolNamesFromRegistry(tools: ToolRegistry): string[] {
  return tools.list().map(tool => tool.name)
}

export class PlanValidator {
  constructor(private readonly options: PlanValidationOptions) {}

  validate(plan: TaskPlan): string[] {
    const errors: string[] = []
    try {
      this.validateOrThrow(plan)
    } catch (error) {
      if (error instanceof MultiAgentError) {
        errors.push(`${error.code}: ${error.message}`)
      } else {
        errors.push(String(error))
      }
    }
    return errors
  }

  validateOrThrow(plan: TaskPlan): void {
    const size = Buffer.byteLength(JSON.stringify(plan))
    if (size > (this.options.maxJsonBytes ?? 128 * 1024)) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Plan JSON too large: ${size}`)
    }
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', 'Plan must contain steps array')
    }
    if (!plan.schemaVersion || !plan.planId || !plan.objective) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', 'Plan is missing required top-level fields')
    }
    if (plan.steps.length === 0) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', 'Plan must contain at least one step')
    }
    if (plan.steps.length > (this.options.maxSteps ?? 10)) {
      throw new MultiAgentError('PLAN_TOO_MANY_STEPS', `Plan has too many steps: ${plan.steps.length}`)
    }

    const ids = new Set<string>()
    for (const step of plan.steps) {
      this.validateStepShape(step)
      if (ids.has(step.id)) {
        throw new MultiAgentError('PLAN_DUPLICATE_STEP_ID', `Duplicate step id: ${step.id}`)
      }
      ids.add(step.id)
      if (step.dependsOn.length > (this.options.maxDependenciesPerStep ?? 5)) {
        throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Too many dependencies for step: ${step.id}`)
      }
      if (step.successCriteria.length > (this.options.maxCriteriaPerStep ?? 10)) {
        throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Too many success criteria for step: ${step.id}`)
      }
      this.validateTools(step)
      this.validateCriteria(step)
    }

    for (const step of plan.steps) {
      const seenDeps = new Set<string>()
      for (const dep of step.dependsOn) {
        if (dep === step.id) {
          throw new MultiAgentError('PLAN_DEPENDENCY_CYCLE', `Step depends on itself: ${step.id}`)
        }
        if (seenDeps.has(dep)) {
          throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Duplicate dependency ${dep} in ${step.id}`)
        }
        seenDeps.add(dep)
        if (!ids.has(dep)) {
          throw new MultiAgentError('PLAN_UNKNOWN_DEPENDENCY', `Unknown dependency ${dep} in ${step.id}`)
        }
      }
    }
    this.topologicalOrder(plan)
    if (!plan.steps.some(step => step.dependsOn.length === 0)) {
      throw new MultiAgentError('PLAN_UNKNOWN_DEPENDENCY', 'Plan must have at least one entry step')
    }
  }

  topologicalOrder(plan: TaskPlan): PlanStep[] {
    const byId = new Map(plan.steps.map(step => [step.id, step]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const ordered: PlanStep[] = []
    const visit = (step: PlanStep) => {
      if (visited.has(step.id)) return
      if (visiting.has(step.id)) {
        throw new MultiAgentError('PLAN_DEPENDENCY_CYCLE', `Dependency cycle at step ${step.id}`)
      }
      visiting.add(step.id)
      for (const dep of step.dependsOn) {
        const depStep = byId.get(dep)
        if (!depStep) {
          throw new MultiAgentError('PLAN_UNKNOWN_DEPENDENCY', `Unknown dependency ${dep}`)
        }
        visit(depStep)
      }
      visiting.delete(step.id)
      visited.add(step.id)
      ordered.push(step)
    }
    for (const step of plan.steps) visit(step)
    return ordered
  }

  private validateStepShape(step: PlanStep): void {
    if (!step.id || !step.title || !step.description) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', 'Step missing id/title/description')
    }
    if (!Array.isArray(step.dependsOn) || !Array.isArray(step.allowedTools)) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Step arrays are invalid: ${step.id}`)
    }
    if (step.allowedTools.length === 0) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Step must declare allowed tools: ${step.id}`)
    }
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5) {
      throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Invalid maxAttempts for step: ${step.id}`)
    }
  }

  private validateTools(step: PlanStep): void {
    const registered = new Set(this.options.registeredTools)
    const forbidden = new Set(this.options.forbiddenTools ?? ['web_fetch', 'web_search', 'delete_everything'])
    for (const tool of step.allowedTools) {
      if (forbidden.has(tool)) {
        throw new MultiAgentError('PLAN_FORBIDDEN_TOOL', `Forbidden tool in plan: ${tool}`)
      }
      if (!registered.has(tool) && tool !== 'none') {
        throw new MultiAgentError('PLAN_UNKNOWN_TOOL', `Unknown tool in plan: ${tool}`)
      }
    }
  }

  private validateCriteria(step: PlanStep): void {
    for (const criterion of step.successCriteria) {
      if (!criterion.id || !CRITERION_TYPES.has(criterion.type)) {
        throw new MultiAgentError('PLAN_SCHEMA_INVALID', `Invalid success criterion in ${step.id}`)
      }
    }
  }
}
