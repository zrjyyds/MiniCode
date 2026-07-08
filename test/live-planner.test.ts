import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlannerOutput, PlannerOutputParseError } from '../src/multi-agent/planner-output-parser.js'
import { PlanValidator } from '../src/multi-agent/plan-validator.js'
import type { PlannerRequest, PlanStep, TaskPlan } from '../src/multi-agent/types.js'
import { MULTI_AGENT_SCHEMA_VERSION, defaultMultiAgentBudgets } from '../src/multi-agent/types.js'
import {
  AnthropicCompatiblePlannerAdapter,
  FakePlannerModelAdapter,
  LiveModelBudgetExceededError,
  LiveModelBudgetTracker,
  LivePlannerAgent,
  assertConfigContainsNoSecrets,
  exactStructuralConsistency,
  loadPlannerLiveConfig,
  resolvePlannerModels,
  semanticStructuralConsistency,
  validatePlannerLiveConfig,
} from '../src/multi-agent/live-planner/index.js'
import { loadPlannerLiveCases, runPlannerLiveBenchmark } from '../src/evaluation/planner-live.js'

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-live-planner-test-'))
}

function step(id: string, patch: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: id,
    description: id,
    dependsOn: [],
    allowedTools: ['none'],
    expectedInputs: [],
    expectedOutputs: [`${id}-out`],
    successCriteria: [{ id: `${id}-done`, type: 'custom_evaluator' }],
    maxAttempts: 1,
    optional: false,
    ...patch,
  }
}

function plan(patch: Partial<TaskPlan> = {}): TaskPlan {
  return {
    schemaVersion: MULTI_AGENT_SCHEMA_VERSION,
    planId: 'plan-test',
    objective: 'test objective',
    assumptions: [],
    constraints: [],
    successCriteria: [{ id: 'task', type: 'custom_evaluator' }],
    steps: [step('A')],
    createdAt: new Date().toISOString(),
    revision: 1,
    ...patch,
  }
}

function request(): PlannerRequest {
  return {
    objective: 'test objective',
    constraints: ['no shell'],
    availableTools: [{ name: 'none', description: 'no tool' }],
    successCriteria: [{ id: 'task', type: 'custom_evaluator' }],
    budgets: defaultMultiAgentBudgets(),
  }
}

function validConfig() {
  return {
    schemaVersion: '1.0',
    providers: [{
      id: 'fake-provider',
      type: 'fake',
      models: [{ id: 'fake-model', model: 'fake-model', enabled: true }],
    }],
    benchmark: {
      repetitions: 1,
      temperature: 0,
      maxOutputTokens: 512,
      requestTimeoutMs: 1000,
      maxRequests: 20,
      maxTotalInputTokens: 10000,
      maxTotalOutputTokens: 10000,
    },
  }
}

function tracker(maxRequests = 5): LiveModelBudgetTracker {
  return new LiveModelBudgetTracker({
    maxRequests,
    maxInputTokens: 10000,
    maxOutputTokens: 10000,
    maxTotalTokens: 20000,
    maxFailures: 5,
    maxConsecutiveFailures: 3,
    maxTotalDurationMs: 60000,
  })
}

describe('planner output parser', () => {
  it('parses direct JSON', () => {
    const result = parsePlannerOutput(JSON.stringify(plan()))
    assert.equal(result.source, 'direct-json')
    assert.equal(result.plan.planId, 'plan-test')
  })

  it('parses JSON code block', () => {
    const result = parsePlannerOutput(`Here\n\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``)
    assert.equal(result.source, 'json-code-block')
  })

  it('parses JSON surrounded by text', () => {
    const result = parsePlannerOutput(`prefix ${JSON.stringify(plan())} suffix`)
    assert.equal(result.source, 'embedded-json')
  })

  it('rejects empty output', () => {
    assert.throws(() => parsePlannerOutput('  '), error => error instanceof PlannerOutputParseError && error.code === 'PLANNER_EMPTY_RESPONSE')
  })

  it('rejects oversized output', () => {
    assert.throws(() => parsePlannerOutput('x'.repeat(20), { maxBytes: 5 }), /exceeds/)
  })

  it('rejects missing JSON', () => {
    assert.throws(() => parsePlannerOutput('plain text only'), error => error instanceof PlannerOutputParseError && error.code === 'PLANNER_JSON_NOT_FOUND')
  })

  it('rejects malformed JSON', () => {
    assert.throws(() => parsePlannerOutput('{"schemaVersion":'), error => error instanceof PlannerOutputParseError && error.code === 'PLANNER_JSON_PARSE_FAILED')
  })

  it('rejects multiple embedded objects', () => {
    const raw = `a ${JSON.stringify(plan())} b ${JSON.stringify(plan({ planId: 'other' }))}`
    assert.throws(() => parsePlannerOutput(raw), error => error instanceof PlannerOutputParseError && error.code === 'PLANNER_MULTIPLE_JSON_OBJECTS')
  })

  it('rejects multiple code blocks', () => {
    const raw = `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\`\n\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``
    assert.throws(() => parsePlannerOutput(raw), /multiple/i)
  })

  it('rejects schema-invalid object', () => {
    assert.throws(() => parsePlannerOutput('{}'), error => error instanceof PlannerOutputParseError && error.code === 'PLANNER_SCHEMA_INVALID')
  })

  it('rejects deep JSON', () => {
    const deep = plan({ assumptions: [[[[['too-deep']]]]] as unknown as string[] })
    assert.throws(() => parsePlannerOutput(JSON.stringify(deep), { maxDepth: 3 }), /depth/)
  })
})

describe('planner live config', () => {
  it('accepts valid fake config', () => {
    const config = validatePlannerLiveConfig(validConfig())
    assert.equal(config.providers[0].type, 'fake')
  })

  it('rejects missing providers', () => {
    assert.throws(() => validatePlannerLiveConfig({ ...validConfig(), providers: [] }), /providers/)
  })

  it('rejects duplicate provider id', () => {
    const provider = validConfig().providers[0]
    assert.throws(() => validatePlannerLiveConfig({ ...validConfig(), providers: [provider, provider] }), /Duplicate provider/)
  })

  it('rejects duplicate model id', () => {
    const config = validConfig()
    config.providers[0].models.push({ id: 'fake-model', model: 'other', enabled: true })
    assert.throws(() => validatePlannerLiveConfig(config), /Duplicate model/)
  })

  it('rejects unknown provider type', () => {
    const config = validConfig()
    config.providers[0].type = 'unknown'
    assert.throws(() => validatePlannerLiveConfig(config), /Unknown planner provider/)
  })

  it('marks missing live environment unavailable without printing values', () => {
    const config = validatePlannerLiveConfig({
      ...validConfig(),
      providers: [{
        id: 'live',
        type: 'anthropic-compatible',
        baseUrlEnv: 'MINICODE_TEST_MISSING_BASE_URL',
        authTokenEnv: 'MINICODE_TEST_MISSING_AUTH_TOKEN',
        models: [{ id: 'm', model: 'm', enabled: true }],
      }],
    })
    const [model] = resolvePlannerModels(config)
    assert.equal(model.environmentAvailable, false)
    assert.equal(model.unavailableCode, 'LIVE_ENVIRONMENT_UNAVAILABLE')
  })

  it('loads config from file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'planner.json')
    await writeFile(file, JSON.stringify(validConfig()), 'utf8')
    const config = await loadPlannerLiveConfig(file)
    assert.equal(config.benchmark.maxRequests, 20)
  })

  it('rejects config containing obvious secrets', () => {
    const config = validatePlannerLiveConfig(validConfig())
    config.providers[0].models[0].model = `sk-${'test-secret'}`
    assert.throws(() => assertConfigContainsNoSecrets(config), /secret/)
  })
})

describe('planner model adapters and live agent', () => {
  it('fake provider returns scripted response and usage', async () => {
    const fake = new FakePlannerModelAdapter([JSON.stringify(plan())])
    const response = await fake.generatePlan({
      systemPrompt: 's',
      plannerContext: request(),
      taskPlanSchema: {},
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      requestId: 'r',
      attempt: 1,
      promptId: 'prompt',
      promptVersion: 'v1',
      promptHash: 'hash',
    })
    assert.equal(response.usage?.totalTokens, 30)
    assert.equal(fake.calls(), 1)
  })

  it('live agent accepts valid fake planner output', async () => {
    const agent = new LivePlannerAgent({
      adapter: new FakePlannerModelAdapter([JSON.stringify(plan())]),
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      registeredTools: ['none'],
      budgetTracker: tracker(),
    })
    const result = await agent.createPlan(request())
    assert.equal(result.planId, 'plan-test')
    assert.equal(agent.results[0].validation.ok, true)
  })

  it('live agent repairs malformed JSON once', async () => {
    const agent = new LivePlannerAgent({
      adapter: new FakePlannerModelAdapter(['{"bad":', JSON.stringify(plan())]),
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      registeredTools: ['none'],
      budgetTracker: tracker(),
    })
    const result = await agent.createPlan(request())
    assert.equal(result.planId, 'plan-test')
    assert.equal(agent.results.at(-1)?.repairUsed, true)
  })

  it('live agent fails when repair also fails', async () => {
    const agent = new LivePlannerAgent({
      adapter: new FakePlannerModelAdapter(['bad', 'still bad']),
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      registeredTools: ['none'],
      budgetTracker: tracker(),
    })
    await assert.rejects(agent.createPlan(request()), /Planner response/)
    assert.equal(agent.results.length, 2)
  })

  it('live agent does not expand forbidden tools during repair', async () => {
    const bad = plan({ steps: [step('A', { allowedTools: ['run_command'] })] })
    const good = plan({ steps: [step('A', { allowedTools: ['none'] })] })
    const agent = new LivePlannerAgent({
      adapter: new FakePlannerModelAdapter([JSON.stringify(bad), JSON.stringify(good)]),
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      registeredTools: ['none'],
      forbiddenTools: ['run_command'],
      budgetTracker: tracker(),
    })
    const result = await agent.createPlan(request())
    assert.deepEqual(result.steps[0].allowedTools, ['none'])
  })

  it('live agent emits safe trace events without auth headers', async () => {
    const events: unknown[] = []
    const agent = new LivePlannerAgent({
      adapter: new FakePlannerModelAdapter([JSON.stringify(plan())]),
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      registeredTools: ['none'],
      budgetTracker: tracker(),
      trace: event => events.push(event),
    })
    await agent.createPlan(request())
    const raw = JSON.stringify(events)
    assert.match(raw, /planner_live_request_started/)
    assert.doesNotMatch(raw, /Authorization|Bearer|AUTH_TOKEN/)
  })

  it('anthropic-compatible adapter parses text and usage', async () => {
    const adapter = new AnthropicCompatiblePlannerAdapter({
      providerId: 'p',
      modelId: 'm',
      baseUrl: 'https://example.invalid',
      authToken: 'secret',
      fetchImpl: async () => new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(plan()) }],
        usage: { input_tokens: 7, output_tokens: 9 },
      }), { status: 200 }),
    })
    const response = await adapter.generatePlan({
      systemPrompt: 's',
      plannerContext: request(),
      taskPlanSchema: {},
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      requestId: 'r',
      attempt: 1,
      promptId: 'prompt',
      promptVersion: 'v1',
      promptHash: 'hash',
    })
    assert.equal(response.usage?.inputTokens, 7)
    assert.equal(parsePlannerOutput(response.rawText).plan.planId, 'plan-test')
  })

  it('anthropic-compatible adapter retries 429 then succeeds', async () => {
    let calls = 0
    const adapter = new AnthropicCompatiblePlannerAdapter({
      providerId: 'p',
      modelId: 'm',
      baseUrl: 'https://example.invalid',
      authToken: 'secret',
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response(JSON.stringify({ error: { message: 'rate' } }), { status: 429 })
        return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(plan()) }] }), { status: 200 })
      },
    })
    await adapter.generatePlan({
      systemPrompt: 's',
      plannerContext: request(),
      taskPlanSchema: {},
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      requestId: 'r',
      attempt: 1,
      promptId: 'prompt',
      promptVersion: 'v1',
      promptHash: 'hash',
    })
    assert.equal(calls, 2)
  })

  it('anthropic-compatible adapter does not retry 401', async () => {
    let calls = 0
    const adapter = new AnthropicCompatiblePlannerAdapter({
      providerId: 'p',
      modelId: 'm',
      baseUrl: 'https://example.invalid',
      authToken: 'secret',
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { message: 'auth failed' } }), { status: 401 })
      },
    })
    await assert.rejects(adapter.generatePlan({
      systemPrompt: 's',
      plannerContext: request(),
      taskPlanSchema: {},
      providerId: 'p',
      modelId: 'm',
      model: 'm',
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1000,
      requestId: 'r',
      attempt: 1,
      promptId: 'prompt',
      promptVersion: 'v1',
      promptHash: 'hash',
    }), /auth failed/)
    assert.equal(calls, 1)
  })
})

describe('live model budget and stability', () => {
  it('enforces request count', () => {
    const budget = tracker(1)
    budget.recordRequest()
    assert.throws(() => budget.assertCanRequest(), LiveModelBudgetExceededError)
  })

  it('tracks token usage', () => {
    const budget = tracker()
    budget.recordSuccess({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    assert.equal(budget.snapshot().totalTokens, 7)
  })

  it('enforces consecutive failures', () => {
    const budget = new LiveModelBudgetTracker({
      maxRequests: 10,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxTotalTokens: 200,
      maxFailures: 10,
      maxConsecutiveFailures: 2,
      maxTotalDurationMs: 1000,
    })
    budget.recordFailure()
    budget.recordFailure()
    assert.throws(() => budget.assertCanRequest(), /maxConsecutiveFailures/)
  })

  it('computes exact structural consistency', () => {
    assert.equal(exactStructuralConsistency([plan(), plan()]), 1)
  })

  it('detects structural inconsistency', () => {
    assert.equal(exactStructuralConsistency([plan(), plan({ steps: [step('A'), step('B')] })]), 0.5)
  })

  it('computes semantic structural consistency deterministically', () => {
    assert.equal(semanticStructuralConsistency([plan(), plan()]), 1)
  })
})

describe('planner live benchmark', () => {
  it('loads at least 18 cases', async () => {
    const cases = await loadPlannerLiveCases(path.resolve('evals', 'planner-live', 'cases'))
    assert.ok(cases.length >= 18)
  })

  it('runs dry-run without invoking live provider', async () => {
    const outputDir = await tempDir()
    const summary = await runPlannerLiveBenchmark({
      config: validatePlannerLiveConfig(validConfig()),
      casesDir: path.resolve('evals', 'planner-live', 'cases'),
      outputDir,
      dryRun: true,
      caseIds: ['simple-no-tool'],
    })
    assert.equal(summary.dryRun, true)
    assert.equal(summary.results.length, 1)
    assert.equal((await readFile(path.join(outputDir, 'PLANNER_BENCHMARK_REPORT.md'), 'utf8')).includes('Dry run'), true)
  })

  it('runs fake provider benchmark for one case', async () => {
    const summary = await runPlannerLiveBenchmark({
      config: validatePlannerLiveConfig(validConfig()),
      casesDir: path.resolve('evals', 'planner-live', 'cases'),
      outputDir: await tempDir(),
      caseIds: ['simple-no-tool'],
    })
    assert.equal(summary.metrics.plan_acceptance_rate, 1)
  })

  it('supports category filtering', async () => {
    const summary = await runPlannerLiveBenchmark({
      config: validatePlannerLiveConfig(validConfig()),
      casesDir: path.resolve('evals', 'planner-live', 'cases'),
      outputDir: await tempDir(),
      category: 'prompt-injection',
      dryRun: true,
    })
    assert.ok(summary.results.length >= 2)
  })

  it('writes JSON, JSONL, CSV, and markdown reports', async () => {
    const outputDir = await tempDir()
    await runPlannerLiveBenchmark({
      config: validatePlannerLiveConfig(validConfig()),
      casesDir: path.resolve('evals', 'planner-live', 'cases'),
      outputDir,
      caseIds: ['simple-no-tool'],
    })
    assert.match(await readFile(path.join(outputDir, 'planner-benchmark.csv'), 'utf8'), /caseId/)
    assert.match(await readFile(path.join(outputDir, 'planner-benchmark.jsonl'), 'utf8'), /simple-no-tool/)
    assert.match(await readFile(path.join(outputDir, 'planner-benchmark.json'), 'utf8'), /promptVersion/)
  })

  it('skips missing live environment without network', async () => {
    const liveConfig = validatePlannerLiveConfig({
      ...validConfig(),
      providers: [{
        id: 'live',
        type: 'anthropic-compatible',
        baseUrlEnv: 'MINICODE_TEST_NO_BASE_URL',
        authTokenEnv: 'MINICODE_TEST_NO_AUTH_TOKEN',
        models: [{ id: 'm', model: 'm', enabled: true }],
      }],
    })
    const summary = await runPlannerLiveBenchmark({
      config: liveConfig,
      casesDir: path.resolve('evals', 'planner-live', 'cases'),
      outputDir: await tempDir(),
      caseIds: ['simple-no-tool'],
    })
    assert.equal(summary.results[0].status, 'skipped')
    assert.equal(summary.results[0].errorCode, 'LIVE_ENVIRONMENT_UNAVAILABLE')
  })
})

describe('plan validator remains external gate', () => {
  it('rejects parser-valid plan with unknown tool', () => {
    const parsed = parsePlannerOutput(JSON.stringify(plan({ steps: [step('A', { allowedTools: ['missing'] })] })))
    assert.match(new PlanValidator({ registeredTools: ['none'] }).validate(parsed.plan).join('\n'), /Unknown tool/)
  })
})
