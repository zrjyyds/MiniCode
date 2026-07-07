import type { MultiAgentRunState, PlanStep, SchedulerResult } from './types.js'

export class StepScheduler {
  schedule(state: MultiAgentRunState): SchedulerResult {
    const completedIds = new Set(
      Object.values(state.stepResults)
        .filter(result => result.status === 'completed' || result.status === 'skipped')
        .map(result => result.stepId),
    )
    const failedIds = new Set(
      Object.values(state.stepResults)
        .filter(result => result.status === 'failed' || result.status === 'blocked')
        .map(result => result.stepId),
    )
    const completedSteps: PlanStep[] = []
    const readySteps: PlanStep[] = []
    const blockedSteps: PlanStep[] = []

    for (const step of state.currentPlan.steps) {
      if (completedIds.has(step.id)) {
        completedSteps.push(step)
        continue
      }
      if (failedIds.has(step.id)) {
        blockedSteps.push(step)
        continue
      }
      if (step.dependsOn.some(dep => failedIds.has(dep))) {
        blockedSteps.push(step)
        continue
      }
      if (step.dependsOn.every(dep => completedIds.has(dep))) {
        readySteps.push(step)
      } else {
        blockedSteps.push(step)
      }
    }

    return {
      selectedStep: readySteps[0],
      readySteps,
      blockedSteps,
      completedSteps,
      reason: readySteps[0]
        ? 'selected first ready step in plan order'
        : completedSteps.length === state.currentPlan.steps.length
          ? 'all steps completed'
          : 'no ready steps',
    }
  }
}
