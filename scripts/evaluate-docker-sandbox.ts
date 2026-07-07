import path from 'node:path'
import { runSandboxEvaluation } from '../src/evaluation/sandbox.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const outputDir = path.resolve(
  argValue('--output') ?? '..',
  argValue('--output') ? '' : 'outputs/phase-5-docker-sandbox/sandbox-eval',
)
const injectFault = process.argv.includes('--inject-fault')
  ? 'omit-network-none'
  : undefined
const summary = await runSandboxEvaluation({
  outputDir,
  all: process.argv.includes('--all'),
  injectFault,
})

const passed = summary.results.filter(result => result.status === 'passed').length
const failed = summary.results.filter(result => result.status === 'failed').length
const skipped = summary.results.filter(result => result.status === 'skipped').length
console.log(`Sandbox Eval: total=${summary.results.length} passed=${passed} failed=${failed} skipped=${skipped}`)
console.log(`Docker available: ${summary.dockerAvailable}`)
console.log(`Real container validation: ${summary.realContainerValidation}`)
if (!summary.dockerAvailable) {
  console.log('Docker沙箱代码与模拟评测通过，真实容器运行验收待补充')
}
process.exit(failed > 0 ? 1 : 0)
