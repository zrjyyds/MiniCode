import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePlannerOutput } from '../src/multi-agent/planner-output-parser.js'

function parseArgs(argv: string[]): { input?: string; mode: 'offline-response' | 'live' } {
  const args: { input?: string; mode: 'offline-response' | 'live' } = { mode: 'offline-response' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') args.input = argv[++index]
    else if (argv[index] === '--mode') args.mode = argv[++index] as 'offline-response' | 'live'
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.input) {
  console.error('Missing required --input <badcase>')
  process.exit(1)
}
if (args.mode === 'live') {
  console.error('Live replay is intentionally not performed by the default replay command.')
  process.exit(1)
}

const responsePath = path.join(args.input, 'response.redacted.txt')
const raw = await readFile(responsePath, 'utf8')
const parsed = parsePlannerOutput(raw)
console.log(`Offline planner badcase replay parsed plan: ${parsed.plan.planId}`)
