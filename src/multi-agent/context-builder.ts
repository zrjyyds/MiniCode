import type {
  CompletedStepSummary,
  ExecuteStepRequest,
  MultiAgentBudgets,
  MultiAgentRunState,
  PlannerRequest,
  ReplanFailureSummary,
} from './types.js'

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /TEST_SECRET_MARKER/g,
  /OPENAI_API_KEY\s*=\s*\S+/g,
  /ANTHROPIC_AUTH_TOKEN\s*=\s*\S+/g,
]

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value)
}

export function summarizeCompletedSteps(state: MultiAgentRunState): CompletedStepSummary[] {
  return state.currentPlan.steps
    .filter(step => state.stepResults[step.id]?.status === 'completed')
    .map(step => ({
      stepId: step.id,
      title: step.title,
      outputs: state.stepResults[step.id]?.artifacts.map(artifact => artifact.summary ?? artifact.path) ?? [],
      artifacts: [...(state.stepResults[step.id]?.artifacts ?? [])],
    }))
}

export class PlannerContextBuilder {
  build(args: {
    objective: string
    constraints: string[]
    tools: Array<{ name: string; description: string }>
    budgets: MultiAgentBudgets
    successCriteria?: PlannerRequest['successCriteria']
    completedSteps?: CompletedStepSummary[]
    failure?: ReplanFailureSummary
    scenario?: string
  }): PlannerRequest {
    return {
      objective: redactSecrets(args.objective),
      constraints: args.constraints.map(redactSecrets),
      availableTools: args.tools.map(tool => ({ ...tool })),
      successCriteria: args.successCriteria ? structuredClone(args.successCriteria) : [],
      budgets: { ...args.budgets },
      scenario: args.scenario,
    }
  }
}

export class ExecutorContextBuilder {
  build(args: {
    state: MultiAgentRunState
    stepId: string
    cwd: string
    attempt: number
    scenario?: string
    injectFailure?: string
  }): ExecuteStepRequest {
    const step = args.state.currentPlan.steps.find(item => item.id === args.stepId)
    if (!step) {
      throw new Error(`Unknown step: ${args.stepId}`)
    }
    return {
      objectiveSummary: redactSecrets(args.state.objective).slice(0, 500),
      planRevision: args.state.currentPlan.revision,
      step: structuredClone(step),
      dependencyOutputs: summarizeCompletedSteps(args.state)
        .filter(summary => step.dependsOn.includes(summary.stepId)),
      allowedTools: [...step.allowedTools],
      cwd: args.cwd,
      attempt: args.attempt,
      budgets: { ...args.state.budgets },
      scenario: args.scenario,
      injectFailure: args.injectFailure,
    }
  }
}
