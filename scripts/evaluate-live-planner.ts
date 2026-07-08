import path from 'node:path'
import { loadPlannerLiveConfig } from '../src/multi-agent/live-planner/config.js'
import { runPlannerLiveBenchmark } from '../src/evaluation/planner-live.js'

type Args = {
  config?: string
  provider?: string
  model?: string
  caseIds: string[]
  category?: string
  repetitions?: number
  mode?: 'planner-only' | 'planner-with-mock-executor'
  output: string
  dryRun: boolean
  noSaveRaw: boolean
  failFast: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    caseIds: [],
    output: path.resolve('..', 'outputs', 'phase-7-real-model-planner'),
    dryRun: false,
    noSaveRaw: false,
    failFast: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--config') args.config = next()
    else if (arg === '--provider') args.provider = next()
    else if (arg === '--model') args.model = next()
    else if (arg === '--case') args.caseIds.push(next())
    else if (arg === '--category') args.category = next()
    else if (arg === '--repetitions') args.repetitions = Number(next())
    else if (arg === '--mode') args.mode = next() as Args['mode']
    else if (arg === '--output') args.output = next()
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-save-raw') args.noSaveRaw = true
    else if (arg === '--fail-fast') args.failFast = true
    else if (arg === '--all' || arg === '--resume') continue
    else if (arg.startsWith('--max-')) index += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.config) {
  console.error('Missing required --config <path>')
  process.exit(1)
}

const config = await loadPlannerLiveConfig(args.config)
const summary = await runPlannerLiveBenchmark({
  config,
  casesDir: path.resolve('evals', 'planner-live', 'cases'),
  outputDir: path.resolve(args.output),
  provider: args.provider,
  model: args.model,
  caseIds: args.caseIds,
  category: args.category,
  repetitions: args.repetitions,
  mode: args.mode ?? 'planner-only',
  dryRun: args.dryRun,
  noSaveRaw: args.noSaveRaw,
  failFast: args.failFast,
})

console.log(`Planner live benchmark: ${summary.results.length} result rows`)
console.log(`Dry run: ${summary.dryRun}`)
console.log(`Output: ${path.resolve(args.output)}`)
console.log(`Parse rate: ${summary.metrics.parse_rate.toFixed(4)}`)
console.log(`Acceptance rate: ${summary.metrics.plan_acceptance_rate.toFixed(4)}`)
