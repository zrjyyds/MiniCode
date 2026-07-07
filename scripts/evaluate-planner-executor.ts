import path from 'node:path'
import { runMultiAgentEvaluation } from '../src/evaluation/multi-agent.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputDir = path.resolve(arg('--output') ?? '..', arg('--output') ? '' : 'outputs/phase-6-planner-executor/multi-agent-eval')
const summary = await runMultiAgentEvaluation({
  outputDir,
  all: process.argv.includes('--all'),
  scenario: arg('--scenario'),
  updateGolden: process.argv.includes('--update-golden'),
  injectFailure: arg('--inject-failure'),
})
const passed = summary.results.filter(result => result.status === 'passed').length
const failed = summary.results.filter(result => result.status === 'failed').length
const errors = summary.results.filter(result => result.status === 'error').length
console.log(`Multi-Agent Eval: total=${summary.results.length} passed=${passed} failed=${failed} errors=${errors}`)
console.log(`Results: ${path.join(outputDir, 'multi-agent-evaluation-summary.md')}`)
process.exit(failed + errors > 0 ? 1 : 0)
