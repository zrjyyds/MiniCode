import path from 'node:path'
import { runAgentLiveEvaluation, type AgentLiveCaseId } from '../src/evaluation/agent-live.js'

type Args = {
  config?: string
  caseIds: AgentLiveCaseId[]
  all: boolean
  output: string
  maxRequests: number
  maxToolCalls: number
  timeoutMs: number
  dryRun: boolean
  noSaveRaw: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    caseIds: [],
    all: false,
    output: path.resolve('..', 'outputs', 'phase-8-real-agent-e2e'),
    maxRequests: 30,
    maxToolCalls: 20,
    timeoutMs: 10 * 60_000,
    dryRun: false,
    noSaveRaw: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--config') args.config = next()
    else if (arg === '--case') args.caseIds.push(next() as AgentLiveCaseId)
    else if (arg === '--all') args.all = true
    else if (arg === '--output') args.output = next()
    else if (arg === '--max-requests') args.maxRequests = Number(next())
    else if (arg === '--max-tool-calls') args.maxToolCalls = Number(next())
    else if (arg === '--timeout') args.timeoutMs = Number(next())
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-save-raw') args.noSaveRaw = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.config) {
  console.error('Missing required --config <path>')
  process.exit(1)
}

const summary = await runAgentLiveEvaluation({
  configPath: path.resolve(args.config),
  outputDir: path.resolve(args.output),
  caseIds: args.caseIds,
  all: args.all,
  dryRun: args.dryRun,
  noSaveRaw: args.noSaveRaw,
  maxRequests: args.maxRequests,
  maxToolCalls: args.maxToolCalls,
  timeoutMs: args.timeoutMs,
})

console.log(`Agent live evaluation: ${summary.results.length} result rows`)
console.log(`Dry run: ${summary.dryRun}`)
console.log(`Output: ${path.resolve(args.output)}`)
console.log(`Passed: ${summary.metrics.passed}`)
console.log(`Skipped: ${summary.metrics.skipped}`)
console.log(`Failed: ${summary.metrics.failed}`)
