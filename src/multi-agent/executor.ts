import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExecuteStepRequest, ExecutorAgent, StepExecutionResult, StepToolCallRecord } from './types.js'

function summarize(value: string, limit = 180): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, limit)}...`
}

function result(args: {
  request: ExecuteStepRequest
  status: StepExecutionResult['status']
  response?: string
  toolCalls?: StepToolCallRecord[]
  errorCode?: string
  errorMessage?: string
}): StepExecutionResult {
  const startedAt = new Date().toISOString()
  const completedAt = new Date().toISOString()
  return {
    stepId: args.request.step.id,
    status: args.status,
    attempt: args.request.attempt,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    assistantResponse: args.response,
    toolCalls: args.toolCalls ?? [],
    artifacts: args.response
      ? [{
          id: `${args.request.step.id}-artifact`,
          path: `memory://${args.request.step.id}`,
          kind: 'text',
          bytes: Buffer.byteLength(args.response),
          summary: summarize(args.response),
        }]
      : [],
    failureStage: args.status === 'completed' ? undefined : 'TOOL_EXECUTION',
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
    reviewerAssertions: [],
  }
}

export class MockExecutorAgent implements ExecutorAgent {
  async executeStep(request: ExecuteStepRequest): Promise<StepExecutionResult> {
    if (request.injectFailure === 'execute-step-out-of-order') {
      return result({
        request,
        status: 'failed',
        errorCode: 'OUT_OF_ORDER',
        errorMessage: 'Injected out-of-order execution fault',
      })
    }
    if (request.scenario === 'executor-forbidden-tool') {
      return result({
        request,
        status: 'completed',
        response: 'attempted forbidden tool',
        toolCalls: [{
          id: 'forbidden-call',
          toolName: 'run_command',
          inputSummary: '{}',
          ok: true,
          outputSummary: 'should be blocked by reviewer',
        }],
      })
    }
    if (request.scenario === 'retry-then-success' && request.attempt === 1) {
      return result({
        request,
        status: 'failed',
        errorCode: 'ASSERTION_FAILED',
        errorMessage: 'first attempt deliberately incomplete',
      })
    }
    if (
      request.step.id === 'failing-step' ||
      request.step.id.startsWith('still-failing')
    ) {
      return result({
        request,
        status: 'failed',
        errorCode: 'SCRIPTED_FAILURE',
        errorMessage: 'scripted executor failure',
      })
    }
    if (request.scenario === 'tool-budget-exceeded') {
      return result({
        request,
        status: 'completed',
        response: 'tool loop requested many reads',
        toolCalls: Array.from({ length: 99 }, (_, index) => ({
          id: `tool-loop-${index}`,
          toolName: 'read_file',
          inputSummary: '{"path":"package.json"}',
          ok: true,
          outputSummary: 'package metadata',
        })),
      })
    }
    if (request.step.id === 'read-package') {
      const packageJson = await readFile(path.join(request.cwd, 'package.json'), 'utf8')
      return result({
        request,
        status: 'completed',
        response: summarize(packageJson),
        toolCalls: [{
          id: 'read-package-call',
          toolName: 'read_file',
          inputSummary: '{"path":"package.json"}',
          ok: true,
          outputSummary: summarize(packageJson),
        }],
      })
    }
    if (request.step.id === 'summarize-package') {
      const packageJson = JSON.parse(await readFile(path.join(request.cwd, 'package.json'), 'utf8')) as {
        name?: string
        scripts?: Record<string, unknown>
      }
      return result({
        request,
        status: 'completed',
        response: `project=${packageJson.name ?? 'unknown'} scripts=${Object.keys(packageJson.scripts ?? {}).length}`,
      })
    }
    return result({
      request,
      status: 'completed',
      response: `${request.step.id} completed`,
    })
  }
}

export class ScriptedExecutorAgent extends MockExecutorAgent {}
