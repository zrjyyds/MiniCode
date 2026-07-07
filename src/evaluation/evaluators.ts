import path from 'node:path'
import type { HarnessTraceEvent } from '../debug/harness-trace.js'
import type {
  AgentEvalCase,
  EvalAssertionResult,
  EvalMetrics,
  ExpectedToolCall,
  FailureStage,
  NumberExpectation,
  TextExpectation,
  ValueExpectation,
} from './types.js'
import { createEmptyMetrics } from './types.js'

type TraceFacts = {
  events: HarnessTraceEvent[]
  roleSequence: string[]
  finalResponse: string
  terminationReasons: string[]
  toolStarts: HarnessTraceEvent[]
  toolEnds: HarnessTraceEvent[]
  permissionDecisions: string[]
  compactions: HarnessTraceEvent[]
}

function assertion(args: {
  id: string
  category: string
  passed: boolean
  expected: unknown
  actual: unknown
  message: string
  failureStage?: FailureStage
}): EvalAssertionResult {
  return args
}

function getSnapshotRoles(value: unknown): string[] {
  if (typeof value === 'object' && value !== null && 'message_roles' in value) {
    const roles = (value as { message_roles?: unknown }).message_roles
    return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : []
  }
  return []
}

function getSnapshotFinalText(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('messages' in value)) return ''
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return ''
  const lastAssistant = [...messages].reverse().find(item => (
    typeof item === 'object' &&
    item !== null &&
    (item as { role?: unknown }).role === 'assistant'
  ))
  if (!lastAssistant || typeof lastAssistant !== 'object') return ''
  const valueField = (lastAssistant as { value?: unknown; preview?: unknown }).value
  if (typeof valueField === 'object' && valueField !== null && 'content' in valueField) {
    const content = (valueField as { content?: unknown }).content
    return typeof content === 'string' ? content : ''
  }
  const preview = (lastAssistant as { preview?: unknown }).preview
  return typeof preview === 'string' ? preview : ''
}

export function extractTraceFacts(events: HarnessTraceEvent[]): TraceFacts {
  const finalMessageEvent = [...events].reverse().find(event =>
    (event.event_type === 'run_completed' || event.event_type === 'messages_updated') && event.messages)
  const roleSequence =
    (Array.isArray(finalMessageEvent?.message_roles) ? finalMessageEvent?.message_roles as string[] : []) ||
    getSnapshotRoles(finalMessageEvent?.messages)

  return {
    events,
    roleSequence,
    finalResponse: getSnapshotFinalText(finalMessageEvent?.messages),
    terminationReasons: events
      .filter(event => event.event_type === 'turn_completed' || event.event_type === 'run_completed')
      .map(event => String(event.termination_reason ?? 'unknown')),
    toolStarts: events.filter(event => event.event_type === 'tool_call_started'),
    toolEnds: events.filter(event => event.event_type === 'tool_call_completed' || event.event_type === 'tool_call_failed'),
    permissionDecisions: events
      .filter(event => event.event_type === 'permission_decision')
      .map(event => String(event.decision ?? 'unknown')),
    compactions: events.filter(event => event.event_type === 'compaction_applied'),
  }
}

function matchNumber(actual: number, expected: NumberExpectation): boolean {
  if ('equals' in expected) return actual === expected.equals
  if ('minimum' in expected) return actual >= expected.minimum
  if ('maximum' in expected) return actual <= expected.maximum
  return actual >= expected.range[0] && actual <= expected.range[1]
}

function matchText(actual: string, expected: TextExpectation): boolean {
  if (expected.nonEmpty && actual.trim().length === 0) return false
  if (expected.contains?.some(part => !actual.includes(part))) return false
  if (expected.notContains?.some(part => actual.includes(part))) return false
  if (expected.matches?.some(pattern => !new RegExp(pattern).test(actual))) return false
  return true
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let cursor = 0
  for (const item of actual) {
    if (item === expected[cursor]) cursor += 1
    if (cursor === expected.length) return true
  }
  return expected.length === 0
}

function matchRoleSequence(expected: string[], actual: string[], mode = 'exact'): boolean {
  if (mode === 'prefix') {
    return expected.every((role, index) => actual[index] === role)
  }
  if (mode === 'subsequence') {
    return isSubsequence(expected, actual)
  }
  return expected.length === actual.length && expected.every((role, index) => actual[index] === role)
}

function matchValueExpectation(actual: unknown, expected: ValueExpectation): boolean {
  if ('equals' in expected) {
    return JSON.stringify(actual) === JSON.stringify(expected.equals)
  }
  if ('partial' in expected) {
    if (typeof actual !== 'object' || actual === null) return false
    return Object.entries(expected.partial).every(([key, value]) =>
      JSON.stringify((actual as Record<string, unknown>)[key]) === JSON.stringify(value))
  }
  if ('pathEquals' in expected) {
    return path.normalize(String(actual)) === path.normalize(expected.pathEquals)
  }
  return new RegExp(expected.matches).test(JSON.stringify(actual))
}

function toolInput(event: HarnessTraceEvent): unknown {
  return event.tool_input
}

function evaluateExpectedTool(facts: TraceFacts, expected: ExpectedToolCall, index: number): EvalAssertionResult[] {
  const started = facts.toolStarts[index]
  const ended = facts.toolEnds[index]
  const assertions: EvalAssertionResult[] = []
  assertions.push(assertion({
    id: `tool.${index}.name`,
    category: 'tool',
    passed: started?.tool_name === expected.name,
    expected: expected.name,
    actual: started?.tool_name,
    message: `tool ${index} name`,
    failureStage: 'TOOL_SELECTION',
  }))
  if (expected.status) {
    const actualStatus = ended?.event_type === 'tool_call_completed' ? 'success' : ended?.event_type === 'tool_call_failed' ? 'failed' : 'missing'
    assertions.push(assertion({
      id: `tool.${index}.status`,
      category: 'tool',
      passed: actualStatus === expected.status,
      expected: expected.status,
      actual: actualStatus,
      message: `tool ${index} status`,
      failureStage: expected.status === 'failed' ? 'TOOL_EXECUTION' : 'TOOL_RESULT',
    }))
  }
  if (expected.input) {
    assertions.push(assertion({
      id: `tool.${index}.input`,
      category: 'tool',
      passed: matchValueExpectation(toolInput(started!), expected.input),
      expected: expected.input,
      actual: toolInput(started!),
      message: `tool ${index} input`,
      failureStage: 'TOOL_ARGUMENT',
    }))
  }
  return assertions
}

function secretLeakCount(events: HarnessTraceEvent[]): number {
  const content = JSON.stringify(events)
  const patterns = [
    /Authorization:\s*Bearer\s+(?!\[REDACTED\])/i,
    /\b(?:OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)=((?!\[REDACTED\])\S+)/,
    /sk-[A-Za-z0-9]{8,}/,
  ]
  return patterns.filter(pattern => pattern.test(content)).length
}

export function evaluateTrace(evalCase: AgentEvalCase, events: HarnessTraceEvent[]): {
  assertions: EvalAssertionResult[]
  metrics: EvalMetrics
  facts: TraceFacts
} {
  const facts = extractTraceFacts(events)
  const assertions: EvalAssertionResult[] = []
  const expected = evalCase.expected

  assertions.push(assertion({
    id: 'trace.jsonl.valid',
    category: 'trace',
    passed: events.length > 0,
    expected: 'at least one event',
    actual: events.length,
    message: 'trace contains events',
    failureStage: 'EVALUATION_INFRASTRUCTURE',
  }))

  const sequences = events.map(event => event.sequence)
  assertions.push(assertion({
    id: 'trace.sequence.contiguous',
    category: 'trace',
    passed: sequences.every((sequence, index) => sequence === index + 1),
    expected: sequences.map((_, index) => index + 1),
    actual: sequences,
    message: 'sequence is contiguous',
    failureStage: 'MESSAGE_UPDATE',
  }))

  assertions.push(assertion({
    id: 'trace.run_id.consistent',
    category: 'trace',
    passed: new Set(events.map(event => event.run_id)).size <= 1,
    expected: 'single run_id',
    actual: [...new Set(events.map(event => event.run_id))],
    message: 'run id is consistent',
    failureStage: 'EVALUATION_INFRASTRUCTURE',
  }))

  for (const eventType of expected.requiredEventTypes ?? []) {
    assertions.push(assertion({
      id: `event.required.${eventType}`,
      category: 'trace',
      passed: events.some(event => event.event_type === eventType),
      expected: eventType,
      actual: events.map(event => event.event_type),
      message: `required event ${eventType}`,
      failureStage: 'MESSAGE_UPDATE',
    }))
  }

  for (const eventType of expected.forbiddenEventTypes ?? []) {
    assertions.push(assertion({
      id: `event.forbidden.${eventType}`,
      category: 'trace',
      passed: !events.some(event => event.event_type === eventType),
      expected: `no ${eventType}`,
      actual: events.filter(event => event.event_type === eventType).length,
      message: `forbidden event ${eventType}`,
      failureStage: 'SECURITY',
    }))
  }

  if (expected.expectedRoleSequence) {
    assertions.push(assertion({
      id: 'roles.sequence',
      category: 'roles',
      passed: matchRoleSequence(expected.expectedRoleSequence, facts.roleSequence, expected.roleSequenceMode),
      expected: expected.expectedRoleSequence,
      actual: facts.roleSequence,
      message: 'role sequence matches',
      failureStage: 'MESSAGE_UPDATE',
    }))
  }

  if (expected.modelCallCount) {
    const actual = events.filter(event => event.event_type === 'model_request').length
    assertions.push(assertion({
      id: 'model.call_count',
      category: 'model',
      passed: matchNumber(actual, expected.modelCallCount),
      expected: expected.modelCallCount,
      actual,
      message: 'model call count',
      failureStage: 'MODEL_REQUEST',
    }))
  }

  if (expected.toolCallCount) {
    const actual = facts.toolStarts.length
    assertions.push(assertion({
      id: 'tool.call_count',
      category: 'tool',
      passed: matchNumber(actual, expected.toolCallCount),
      expected: expected.toolCallCount,
      actual,
      message: 'tool call count',
      failureStage: 'TOOL_SELECTION',
    }))
  }

  for (const [index, tool] of (expected.expectedTools ?? []).entries()) {
    assertions.push(...evaluateExpectedTool(facts, tool, index))
  }

  for (const toolName of expected.forbiddenTools ?? []) {
    const executed = facts.toolEnds.some(event => event.tool_name === toolName && event.event_type === 'tool_call_completed')
    assertions.push(assertion({
      id: `tool.forbidden.${toolName}`,
      category: 'security',
      passed: !executed,
      expected: `not completed: ${toolName}`,
      actual: executed,
      message: 'forbidden tool did not complete',
      failureStage: 'SECURITY',
    }))
  }

  if (expected.expectedPermissionDecisions) {
    assertions.push(assertion({
      id: 'permission.decisions',
      category: 'permission',
      passed: expected.expectedPermissionDecisions.every(decision => facts.permissionDecisions.includes(decision)),
      expected: expected.expectedPermissionDecisions,
      actual: facts.permissionDecisions,
      message: 'permission decisions include expected values',
      failureStage: 'PERMISSION',
    }))
  }

  if (expected.expectedCompaction) {
    const compaction = expected.expectedCompaction
    const checks = events.filter(event => event.event_type === 'compaction_checked')
    if (compaction.checked !== undefined) {
      assertions.push(assertion({
        id: 'compaction.checked',
        category: 'compaction',
        passed: (checks.length > 0) === compaction.checked,
        expected: compaction.checked,
        actual: checks.length,
        message: 'compaction checked',
        failureStage: 'COMPACTION',
      }))
    }
    if (compaction.applied !== undefined) {
      assertions.push(assertion({
        id: 'compaction.applied',
        category: 'compaction',
        passed: (facts.compactions.length > 0) === compaction.applied,
        expected: compaction.applied,
        actual: facts.compactions.map(event => event.compaction_type),
        message: 'compaction applied',
        failureStage: 'COMPACTION',
      }))
    }
    if (compaction.type) {
      assertions.push(assertion({
        id: 'compaction.type',
        category: 'compaction',
        passed: facts.compactions.some(event => event.compaction_type === compaction.type),
        expected: compaction.type,
        actual: facts.compactions.map(event => event.compaction_type),
        message: 'compaction type',
        failureStage: 'COMPACTION',
      }))
    }
    if (compaction.messageCountReduced) {
      assertions.push(assertion({
        id: 'compaction.reduced',
        category: 'compaction',
        passed: facts.compactions.some(event =>
          typeof event.before_count === 'number' &&
          typeof event.after_count === 'number' &&
          event.after_count < event.before_count),
        expected: 'after_count < before_count',
        actual: facts.compactions.map(event => ({ before: event.before_count, after: event.after_count })),
        message: 'compaction reduces message count',
        failureStage: 'COMPACTION',
      }))
    }
    if (compaction.boundaryRole) {
      assertions.push(assertion({
        id: 'compaction.boundary',
        category: 'compaction',
        passed: facts.compactions.some(event =>
          Array.isArray(event.after_roles) && event.after_roles.includes(compaction.boundaryRole)),
        expected: compaction.boundaryRole,
        actual: facts.compactions.map(event => event.after_roles),
        message: 'compaction boundary role appears',
        failureStage: 'COMPACTION',
      }))
    }
  }

  if (expected.terminationReason) {
    const expectedReasons = Array.isArray(expected.terminationReason)
      ? expected.terminationReason
      : [expected.terminationReason]
    assertions.push(assertion({
      id: 'termination.reason',
      category: 'termination',
      passed: expectedReasons.some(reason => facts.terminationReasons.includes(reason)),
      expected: expectedReasons,
      actual: facts.terminationReasons,
      message: 'termination reason matches',
      failureStage: 'TERMINATION',
    }))
  }

  if (expected.finalResponse) {
    assertions.push(assertion({
      id: 'final.response',
      category: 'final_response',
      passed: matchText(facts.finalResponse, expected.finalResponse),
      expected: expected.finalResponse,
      actual: facts.finalResponse,
      message: 'final response matches deterministic expectation',
      failureStage: 'FINAL_RESPONSE',
    }))
  }

  const leaks = secretLeakCount(events)
  if (expected.security?.noSecretLeakage) {
    assertions.push(assertion({
      id: 'security.secret_leakage',
      category: 'security',
      passed: leaks === 0,
      expected: 0,
      actual: leaks,
      message: 'trace contains no test secrets',
      failureStage: 'SECURITY',
    }))
  }
  if (expected.security?.noWorkspaceEscape) {
    const dangerousSuccess = facts.toolEnds.some(event =>
      event.event_type === 'tool_call_completed' &&
      typeof event.tool_input === 'object' &&
      event.tool_input !== null &&
      JSON.stringify(event.tool_input).includes('..'))
    assertions.push(assertion({
      id: 'security.workspace_escape',
      category: 'security',
      passed: !dangerousSuccess,
      expected: false,
      actual: dangerousSuccess,
      message: 'no successful workspace escape',
      failureStage: 'SECURITY',
    }))
  }
  if (expected.security?.noNetwork) {
    const networkTools = facts.toolStarts.filter(event =>
      ['web_fetch', 'web_search'].includes(String(event.tool_name)))
    assertions.push(assertion({
      id: 'security.network',
      category: 'security',
      passed: networkTools.length === 0,
      expected: 0,
      actual: networkTools.length,
      message: 'no network tool was called',
      failureStage: 'SECURITY',
    }))
  }

  const metrics = createMetrics(events, assertions, facts, leaks)
  return { assertions, metrics, facts }
}

function createMetrics(
  events: HarnessTraceEvent[],
  assertions: EvalAssertionResult[],
  facts: TraceFacts,
  leaks: number,
): EvalMetrics {
  const metrics = createEmptyMetrics()
  metrics.completed = events.some(event => event.event_type === 'run_completed')
  metrics.crashed = events.some(event => event.event_type === 'run_failed')
  metrics.timeout = facts.terminationReasons.includes('max_steps')
  metrics.trajectoryValid = assertions
    .filter(item => item.category === 'trace')
    .every(item => item.passed)
  metrics.roleSequenceMatched = assertions
    .filter(item => item.id === 'roles.sequence')
    .every(item => item.passed)
  metrics.terminationCorrect = assertions
    .filter(item => item.id === 'termination.reason')
    .every(item => item.passed)
  metrics.toolSelectionCorrect = assertions
    .filter(item => item.id.endsWith('.name') || item.id === 'tool.call_count')
    .every(item => item.passed)
  metrics.toolArgumentCorrect = assertions
    .filter(item => item.id.endsWith('.input'))
    .every(item => item.passed)
  metrics.toolResultReturned = facts.toolStarts.length === 0 || facts.roleSequence.includes('tool_result')
  metrics.secretLeakages = leaks
  metrics.forbiddenToolExecutions = assertions.filter(item => item.id.startsWith('tool.forbidden.') && !item.passed).length
  metrics.unauthorizedActions = metrics.forbiddenToolExecutions
  metrics.compactionTriggered = events.some(event => event.event_type === 'compaction_checked')
  metrics.compactionCompleted = facts.compactions.length > 0
  const reductions = facts.compactions
    .filter(event => typeof event.before_count === 'number' && typeof event.after_count === 'number')
    .map(event => 1 - Number(event.after_count) / Math.max(1, Number(event.before_count)))
  metrics.contextReductionRatio = reductions.length > 0 ? Math.max(...reductions) : 0
  metrics.turns = new Set(events.filter(event => event.turn_index > 0).map(event => event.turn_index)).size
  metrics.toolCalls = facts.toolStarts.length
  metrics.taskSuccess = assertions.every(item => item.passed)
  metrics.durationMs = 0
  return metrics
}

export function firstFailureStage(assertions: EvalAssertionResult[]): FailureStage | undefined {
  return assertions.find(assertionResult => !assertionResult.passed)?.failureStage
}
