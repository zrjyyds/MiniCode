import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runMultiAgentEvaluation } from '../src/evaluation/multi-agent.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const input = arg('--input')
if (!input) {
  console.error('Usage: --input <badcase-dir>')
  process.exit(2)
}
const badcase = JSON.parse(await readFile(path.join(input, 'badcase.json'), 'utf8')) as {
  case_id: string
  fault?: string
}
const outputDir = path.resolve(arg('--output') ?? path.join(input, 'replay'))
await mkdir(outputDir, { recursive: true })
const reproduced = await runMultiAgentEvaluation({
  outputDir: path.join(outputDir, 'reproduced'),
  scenario: badcase.case_id,
  injectFailure: badcase.fault,
})
const resolved = await runMultiAgentEvaluation({
  outputDir: path.join(outputDir, 'resolved'),
  scenario: badcase.case_id,
})
const result = {
  schema_version: '1.0',
  originalCaseId: badcase.case_id,
  reproduced: reproduced.results[0]?.status === 'failed' ? 'REPRODUCED' : 'NOT_REPRODUCED',
  resolved: resolved.results[0]?.status === 'passed' ? 'RESOLVED' : 'NOT_RESOLVED',
}
await writeFile(path.join(outputDir, 'replay-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(`${result.reproduced} -> ${result.resolved}`)
process.exit(result.reproduced === 'REPRODUCED' && result.resolved === 'RESOLVED' ? 0 : 1)
