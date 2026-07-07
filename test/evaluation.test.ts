import { spawn } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HarnessTraceEvent } from '../src/debug/harness-trace.js'
import { DEFAULT_EVAL_CASES } from '../src/evaluation/cases.js'
import { evaluateTrace } from '../src/evaluation/evaluators.js'
import { replayBadcase } from '../src/evaluation/replay.js'
import { calculateAggregateMetrics, runEvaluation } from '../src/evaluation/runner.js'
import { validateEvalCase, validateEvalCases } from '../src/evaluation/schema.js'
import type { AgentEvalCase } from '../src/evaluation/types.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-eval-test-'))
}

function event(sequence: number, event_type: HarnessTraceEvent['event_type'], extra: Record<string, unknown> = {}): HarnessTraceEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    sequence,
    event_type,
    timestamp: new Date(0 + sequence).toISOString(),
    turn_index: sequence === 1 ? 0 : 1,
    ...extra,
  }
}

function readSuccessEvents(): HarnessTraceEvent[] {
  return [
    event(1, 'run_started'),
    event(2, 'turn_started', { message_count: 2, message_roles: ['system', 'user'] }),
    event(3, 'model_request'),
    event(4, 'model_response', { response_type: 'tool_calls' }),
    event(5, 'tool_call_started', { tool_name: 'read_file', tool_call_id: 'call-1', tool_input: { path: 'package.json' } }),
    event(6, 'permission_decision', { decision: 'not_required', tool_name: 'read_file', tool_call_id: 'call-1' }),
    event(7, 'tool_call_completed', { tool_name: 'read_file', tool_call_id: 'call-1', result_length: 10 }),
    event(8, 'messages_updated', { message_roles: ['system', 'user', 'assistant_tool_call', 'tool_result'] }),
    event(9, 'model_request'),
    event(10, 'model_response', { response_type: 'assistant' }),
    event(11, 'messages_updated', {
      message_roles: ['system', 'user', 'assistant_tool_call', 'tool_result', 'assistant'],
      messages: {
        message_roles: ['system', 'user', 'assistant_tool_call', 'tool_result', 'assistant'],
        messages: [{ role: 'assistant', preview: '文件内容如下' }],
      },
    }),
    event(12, 'turn_completed', { termination_reason: 'assistant_final' }),
    event(13, 'run_completed', {
      termination_reason: 'scenario_completed',
      message_roles: ['system', 'user', 'assistant_tool_call', 'tool_result', 'assistant'],
      messages: {
        message_roles: ['system', 'user', 'assistant_tool_call', 'tool_result', 'assistant'],
        messages: [{ role: 'assistant', preview: '文件内容如下' }],
      },
    }),
  ]
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'evaluate-agent-harness.ts'), ...args], {
      cwd: root,
      env: { ...process.env, MINI_CODE_MODEL_MODE: 'mock' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('exit', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('evaluation case schema', () => {
  it('accepts default cases and rejects duplicate ids', () => {
    assert.deepEqual(validateEvalCases(DEFAULT_EVAL_CASES), [])
    assert.ok(validateEvalCases([DEFAULT_EVAL_CASES[0]!, DEFAULT_EVAL_CASES[0]!]).some(error => error.includes('duplicate')))
  })

  it('rejects missing id, invalid category, and invalid expectation operators', () => {
    const invalid = {
      ...DEFAULT_EVAL_CASES[0]!,
      id: '',
      category: 'unknown',
      expected: { modelCallCount: { equals: 1, minimum: 1 } },
    }
    const errors = validateEvalCase(invalid)
    assert.ok(errors.some(error => error.includes('id')))
    assert.ok(errors.some(error => error.includes('category')))
    assert.ok(errors.some(error => error.includes('modelCallCount')))
  })
})

describe('evaluation evaluators', () => {
  it('passes trace, role, tool, permission, termination, security, and final response assertions', () => {
    const evalCase = DEFAULT_EVAL_CASES.find(item => item.id === 'read-file-success')!
    const result = evaluateTrace(evalCase, readSuccessEvents())
    assert.equal(result.assertions.every(item => item.passed), true)
    assert.equal(result.metrics.trajectoryValid, true)
    assert.equal(result.metrics.toolSelectionCorrect, true)
    assert.equal(result.metrics.toolArgumentCorrect, true)
    assert.equal(result.metrics.toolResultReturned, true)
  })

  it('fails each major evaluator with stage information', () => {
    const evalCase: AgentEvalCase = {
      ...DEFAULT_EVAL_CASES.find(item => item.id === 'read-file-success')!,
      expected: {
        ...DEFAULT_EVAL_CASES.find(item => item.id === 'read-file-success')!.expected,
        expectedRoleSequence: ['system', 'assistant'],
        expectedTools: [{ name: 'grep_files', status: 'failed', input: { partial: { path: 'README.md' } } }],
        expectedPermissionDecisions: ['approved'],
        expectedCompaction: { checked: true, applied: true, type: 'snip', messageCountReduced: true },
        finalResponse: { contains: ['missing keyword'] },
        forbiddenEventTypes: ['model_request'],
        security: { noSecretLeakage: true, noNetwork: true, noWorkspaceEscape: true },
      },
    }
    const events = [
      ...readSuccessEvents(),
      event(14, 'model_request', { run_id: 'run-1' }),
      event(15, 'tool_call_started', { tool_name: 'web_fetch' }),
    ]
    const result = evaluateTrace(evalCase, events)
    const failed = result.assertions.filter(item => !item.passed)
    assert.ok(failed.length >= 8)
    assert.ok(failed.some(item => item.failureStage === 'TOOL_SELECTION'))
    assert.ok(failed.some(item => item.failureStage === 'TOOL_ARGUMENT'))
    assert.ok(failed.some(item => item.failureStage === 'PERMISSION'))
    assert.ok(failed.some(item => item.failureStage === 'COMPACTION'))
    assert.ok(failed.some(item => item.failureStage === 'FINAL_RESPONSE'))
    assert.ok(failed.some(item => item.failureStage === 'SECURITY'))
  })

  it('detects compaction pass and failure', () => {
    const evalCase = DEFAULT_EVAL_CASES.find(item => item.id === 'compaction-snip')!
    const events = [
      event(1, 'run_started'),
      event(2, 'compaction_checked'),
      event(3, 'compaction_applied', {
        compaction_type: 'snip',
        before_count: 100,
        after_count: 20,
        after_roles: ['system', 'snip_boundary', 'user'],
      }),
      event(4, 'messages_updated', { messages: { messages: [{ role: 'assistant', preview: 'ok' }] } }),
      event(5, 'turn_completed', { termination_reason: 'assistant_final' }),
      event(6, 'run_completed', { termination_reason: 'scenario_completed' }),
    ]
    assert.equal(evaluateTrace(evalCase, events).assertions.every(item => item.passed), true)
    assert.ok(evaluateTrace(evalCase, events.filter(item => item.event_type !== 'compaction_applied')).assertions.some(item => !item.passed))
  })
})

describe('evaluation runner and badcases', () => {
  it('runs a single case and all cases', async () => {
    const one = await runEvaluation({ outputDir: await tempDir(), caseId: 'simple-answer' })
    assert.equal(one.results.length, 1)
    assert.equal(one.results[0]?.status, 'passed')

    const all = await runEvaluation({ outputDir: await tempDir() })
    assert.equal(all.results.length, 10)
    assert.equal(all.results.every(result => result.status === 'passed'), true)
    await stat(path.join(path.dirname(all.results[0]!.tracePath!), '..', '..', 'evaluation-results.json'))
  })

  it('filters by tag and supports fail-fast', async () => {
    const tagged = await runEvaluation({ outputDir: await tempDir(), tag: 'compaction' })
    assert.deepEqual(tagged.results.map(result => result.caseId), ['compaction-snip'])

    const failed = await runEvaluation({ outputDir: await tempDir(), injectFailure: 'wrong-tool', failFast: true })
    assert.equal(failed.results.some(result => result.status === 'failed'), true)
    assert.ok(failed.results.length < 10)
  })

  it('generates badcase without test secrets and includes replay command', async () => {
    const summary = await runEvaluation({ outputDir: await tempDir(), injectFailure: 'wrong-tool' })
    const badcase = summary.results.find(result => result.badcasePath)
    assert.ok(badcase?.badcasePath)
    const content = await readFile(path.join(badcase.badcasePath, 'badcase.json'), 'utf8')
    assert.ok(content.includes('replay_command'))
    assert.ok(!content.includes('sk-test'))
  })

  it('does not generate badcases for passing cases by default', async () => {
    const summary = await runEvaluation({ outputDir: await tempDir(), caseId: 'simple-answer' })
    assert.equal(summary.results[0]?.badcasePath, undefined)
  })
})

describe('badcase replay', () => {
  it('reproduces an injected badcase and reports resolved with a corrected case override', async () => {
    const output = await tempDir()
    const summary = await runEvaluation({ outputDir: output, injectFailure: 'wrong-tool' })
    const badcasePath = summary.results.find(result => result.badcasePath)?.badcasePath
    assert.ok(badcasePath)

    const reproduced = await replayBadcase({ input: badcasePath, outputDir: await tempDir(), compare: true })
    assert.equal(reproduced.status, 'REPRODUCED')

    const resolved = await replayBadcase({
      input: badcasePath,
      outputDir: await tempDir(),
      compare: true,
      overrideCase: DEFAULT_EVAL_CASES.find(item => item.id === 'read-file-success'),
    })
    assert.equal(resolved.status, 'RESOLVED')
  })

  it('handles schema errors, missing fixtures, and environment mismatch placeholders as replay errors', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'badcase.json'), '{"schema_version":"0","case_id":"x"}\n', 'utf8')
    assert.equal((await replayBadcase({ input: dir, outputDir: await tempDir(), compare: true })).status, 'REPLAY_ERROR')
    assert.equal((await replayBadcase({ input: path.join(dir, 'missing.json'), outputDir: await tempDir(), compare: true })).status, 'REPLAY_ERROR')
  })
})

describe('evaluation metrics and CLI', () => {
  it('handles empty denominators and skipped/error separation', () => {
    const metrics = calculateAggregateMetrics([])
    assert.equal(metrics.case_count, 0)
    assert.equal(metrics.pass_rate, 0)
    const withError = calculateAggregateMetrics([{
      schemaVersion: '1.0',
      evaluationRunId: 'run',
      caseId: 'x',
      status: 'error',
      startedAt: '',
      completedAt: '',
      durationMs: 0,
      assertions: [],
      metrics: {
        taskSuccess: false,
        completed: false,
        crashed: true,
        timeout: false,
        trajectoryValid: false,
        roleSequenceMatched: false,
        terminationCorrect: false,
        toolSelectionCorrect: false,
        toolArgumentCorrect: false,
        toolResultReturned: false,
        unauthorizedActions: 0,
        secretLeakages: 0,
        forbiddenToolExecutions: 0,
        compactionTriggered: false,
        compactionCompleted: false,
        contextReductionRatio: 0,
        transcriptPreserved: true,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
        traceParseErrors: 1,
      },
      failureReasons: ['infra'],
    }])
    assert.equal(withError.error_count, 1)
    assert.equal(withError.failed_count, 0)
  })

  it('lists cases and returns non-zero for injected failures', async () => {
    const listed = await runCli(['--list'])
    assert.equal(listed.code, 0)
    assert.match(listed.stdout, /read-file-success/)

    const failed = await runCli(['--all', '--inject-failure', 'wrong-tool', '--output', await tempDir(), '--fail-fast'])
    assert.equal(failed.code, 1)
    assert.match(failed.stdout, /failed=1/)
  })
})
