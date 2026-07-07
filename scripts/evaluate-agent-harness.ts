import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { listEvalCases } from '../src/evaluation/cases.js'
import { loadBaseline, runEvaluation } from '../src/evaluation/runner.js'

type CliOptions = {
  list: boolean
  all: boolean
  caseId?: string
  category?: string
  tag?: string
  output: string
  failFast: boolean
  updateGolden: boolean
  savePassedTraces: boolean
  keepFixtures: boolean
  injectFailure?: string
  baseline?: string
}

function usage(): string {
  return [
    'Usage: npm run eval:harness -- [--all|--case <id>|--category <category>|--tag <tag>] [options]',
    '',
    'Options:',
    '  --list',
    '  --all',
    '  --case <id>',
    '  --category <category>',
    '  --tag <tag>',
    '  --output <directory>',
    '  --fail-fast',
    '  --update-golden',
    '  --save-passed-traces',
    '  --keep-fixtures',
    '  --inject-failure <wrong-tool>',
    '  --baseline <path>',
    '',
    'Exit codes:',
    '  0: all selected cases passed',
    '  1: product regression or assertion failure',
    '  2: evaluation infrastructure error',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    all: false,
    output: path.resolve('..', 'outputs', 'phase-4-agent-evaluation', 'eval-run'),
    failFast: false,
    updateGolden: false,
    savePassedTraces: false,
    keepFixtures: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') options.list = true
    else if (arg === '--all') options.all = true
    else if (arg === '--case') options.caseId = argv[++i]
    else if (arg === '--category') options.category = argv[++i]
    else if (arg === '--tag') options.tag = argv[++i]
    else if (arg === '--output') options.output = path.resolve(argv[++i] ?? '')
    else if (arg === '--fail-fast') options.failFast = true
    else if (arg === '--update-golden') options.updateGolden = true
    else if (arg === '--save-passed-traces') options.savePassedTraces = true
    else if (arg === '--keep-fixtures') options.keepFixtures = true
    else if (arg === '--inject-failure') options.injectFailure = argv[++i]
    else if (arg === '--baseline') options.baseline = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
    }
  }
  return options
}

async function updateGoldenFiles(outputDir: string): Promise<void> {
  const resultPath = path.join(outputDir, 'evaluation-results.json')
  const summary = JSON.parse(await readFile(resultPath, 'utf8')) as {
    results: Array<{ caseId: string; tracePath?: string }>
  }
  const goldenDir = path.resolve('evals', 'golden')
  await mkdir(goldenDir, { recursive: true })
  for (const result of summary.results) {
    if (!result.tracePath) continue
    const events = (await readFile(result.tracePath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    const final = [...events].reverse().find(event => event.message_roles)
    const tools = events.filter(event => event.event_type === 'tool_call_started').map(event => event.tool_name)
    const toolStatus = events
      .filter(event => event.event_type === 'tool_call_completed' || event.event_type === 'tool_call_failed')
      .map(event => event.event_type === 'tool_call_completed' ? 'success' : 'failed')
    const termination = [...events].reverse().find(event => event.event_type === 'turn_completed')?.termination_reason
    const nextGolden = {
      role_sequence: final?.message_roles ?? [],
      tool_sequence: tools,
      tool_status: toolStatus,
      termination_reason: termination,
    }
    const target = path.join(goldenDir, `${result.caseId}.json`)
    console.log(`Updating golden: ${target}`)
    await writeFile(target, `${JSON.stringify(nextGolden, null, 2)}\n`, 'utf8')
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const cases = listEvalCases()
  if (options.list) {
    for (const evalCase of cases) {
      console.log(`${evalCase.id}\t${evalCase.category}\t${evalCase.tags.join(',')}`)
    }
    return
  }

  process.env.MINI_CODE_MODEL_MODE = 'mock'
  process.env.MINI_CODE_HOME = path.join(options.output, '.mini-code-home')

  const summary = await runEvaluation({
    outputDir: options.output,
    caseId: options.caseId,
    category: options.category,
    tag: options.tag,
    failFast: options.failFast,
    savePassedTraces: options.savePassedTraces,
    keepFixtures: options.keepFixtures,
    injectFailure: options.injectFailure,
    baseline: await loadBaseline(options.baseline),
  })

  if (options.updateGolden) {
    await updateGoldenFiles(options.output)
  }

  const passed = summary.results.filter(result => result.status === 'passed').length
  const failed = summary.results.filter(result => result.status === 'failed').length
  const errors = summary.results.filter(result => result.status === 'error').length
  const baselineRegression = hasBaselineRegression(summary.metrics, summary.baseline)
  console.log(`Evaluation complete: passed=${passed} failed=${failed} errors=${errors}`)
  console.log(`Results: ${path.join(options.output, 'evaluation-summary.md')}`)
  if (errors > 0) process.exit(2)
  if (failed > 0 || baselineRegression) process.exit(1)
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})

function hasBaselineRegression(
  metrics: Record<string, number>,
  baseline: Record<string, unknown> | undefined,
): boolean {
  if (!baseline) return false
  const nonDecreasing = [
    'trajectory_validity_rate',
    'tool_selection_accuracy',
    'termination_correctness_rate',
  ]
  for (const key of nonDecreasing) {
    const baselineValue = Number(baseline[key] ?? 0)
    if (metrics[key] !== undefined && metrics[key] < baselineValue) {
      console.error(`Baseline regression: ${key} ${baselineValue} -> ${metrics[key]}`)
      return true
    }
  }
  const baselineSecurity = Number(baseline.security_violation_count ?? 0)
  if ((metrics.security_violation_count ?? 0) > baselineSecurity) {
    console.error(`Baseline regression: security_violation_count ${baselineSecurity} -> ${metrics.security_violation_count}`)
    return true
  }
  return false
}
