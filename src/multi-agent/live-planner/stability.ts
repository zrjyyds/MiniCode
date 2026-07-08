import type { TaskPlan } from '../types.js'

export type PlanSignature = {
  stepCount: number
  dependencyEdges: string[]
  toolSequence: string[]
  successCriterionTypes: string[]
}

export function planSignature(plan: TaskPlan): PlanSignature {
  return {
    stepCount: plan.steps.length,
    dependencyEdges: plan.steps
      .flatMap(step => step.dependsOn.map(dep => `${dep}->${step.id}`))
      .sort(),
    toolSequence: plan.steps.map(step => step.allowedTools.join('+')),
    successCriterionTypes: plan.steps.flatMap(step => step.successCriteria.map(criterion => criterion.type)).sort(),
  }
}

export function exactStructuralConsistency(plans: TaskPlan[]): number {
  if (plans.length <= 1) return 1
  const signatures = plans.map(plan => JSON.stringify(planSignature(plan)))
  return signatures.filter(signature => signature === signatures[0]).length / signatures.length
}

export function semanticStructuralConsistency(plans: TaskPlan[]): number {
  return exactStructuralConsistency(plans)
}
