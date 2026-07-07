import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MultiAgentError } from './errors.js'
import type { MultiAgentRunState, MultiAgentTraceEvent, StepExecutionResult } from './types.js'
import { MULTI_AGENT_SCHEMA_VERSION } from './types.js'

export type MultiAgentStateStorePaths = {
  runDir: string
  statePath: string
  planCurrentPath: string
  planHistoryPath: string
  stepResultsPath: string
  tracePath: string
  artifactsDir: string
}

export class MultiAgentStateStore {
  constructor(private readonly rootDir: string) {}

  paths(runId: string): MultiAgentStateStorePaths {
    const runDir = path.resolve(this.rootDir, 'multi-agent-runs', runId)
    return {
      runDir,
      statePath: path.join(runDir, 'state.json'),
      planCurrentPath: path.join(runDir, 'plan-current.json'),
      planHistoryPath: path.join(runDir, 'plan-history.jsonl'),
      stepResultsPath: path.join(runDir, 'step-results.jsonl'),
      tracePath: path.join(runDir, 'trace.jsonl'),
      artifactsDir: path.join(runDir, 'artifacts'),
    }
  }

  async initRun(runId: string): Promise<MultiAgentStateStorePaths> {
    const paths = this.paths(runId)
    await mkdir(paths.artifactsDir, { recursive: true })
    return paths
  }

  async saveState(state: MultiAgentRunState): Promise<MultiAgentStateStorePaths> {
    const paths = await this.initRun(state.runId)
    await atomicJson(paths.statePath, state)
    await atomicJson(paths.planCurrentPath, state.currentPlan)
    await writeFile(
      paths.planHistoryPath,
      state.planHistory.map(plan => JSON.stringify(plan)).join('\n') + '\n',
      'utf8',
    )
    await writeFile(
      paths.stepResultsPath,
      Object.values(state.stepResults).map(result => JSON.stringify(result)).join('\n') + '\n',
      'utf8',
    )
    return paths
  }

  async appendTrace(runId: string, event: Omit<MultiAgentTraceEvent, 'timestamp' | 'run_id'>): Promise<void> {
    const paths = await this.initRun(runId)
    const full = {
      timestamp: new Date().toISOString(),
      run_id: runId,
      ...event,
    } as MultiAgentTraceEvent
    const { appendFile } = await import('node:fs/promises')
    await appendFile(paths.tracePath, `${JSON.stringify(full)}\n`, 'utf8')
  }

  async loadState(input: string): Promise<MultiAgentRunState> {
    const statePath = input.endsWith('.json') ? path.resolve(input) : this.paths(input).statePath
    let parsed: MultiAgentRunState
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf8')) as MultiAgentRunState
    } catch (error) {
      throw new MultiAgentError('CHECKPOINT_INVALID', `Cannot read checkpoint: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed.schemaVersion !== MULTI_AGENT_SCHEMA_VERSION) {
      throw new MultiAgentError('CHECKPOINT_INVALID', `Unsupported checkpoint schema: ${parsed.schemaVersion}`)
    }
    return parsed
  }

  async validateArtifacts(state: MultiAgentRunState): Promise<void> {
    for (const result of Object.values(state.stepResults)) {
      for (const artifact of result.artifacts) {
        if (artifact.path.startsWith('memory://')) continue
        try {
          await stat(artifact.path)
        } catch {
          throw new MultiAgentError('CHECKPOINT_INVALID', `Missing artifact: ${artifact.path}`)
        }
      }
    }
  }
}

async function atomicJson(filepath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filepath), { recursive: true })
  const temp = `${filepath}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, filepath)
}

export function markInterruptedSteps(state: MultiAgentRunState): MultiAgentRunState {
  if (state.status !== 'executing_step' || !state.currentStepId) {
    return state
  }
  return {
    ...state,
    status: 'ready',
    stepResults: {
      ...state.stepResults,
      [state.currentStepId]: {
        stepId: state.currentStepId,
        status: 'interrupted',
        attempt: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        toolCalls: [],
        artifacts: [],
        failureStage: 'EVALUATION_INFRASTRUCTURE',
        errorCode: 'INTERRUPTED',
        errorMessage: 'Step was interrupted before completion record',
        reviewerAssertions: [],
      } satisfies StepExecutionResult,
    },
    currentStepId: undefined,
    updatedAt: new Date().toISOString(),
  }
}
