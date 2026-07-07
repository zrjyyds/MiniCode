import path from 'node:path'
import { replayBadcase } from '../src/evaluation/replay.js'

type CliOptions = {
  input?: string
  output: string
  compare: boolean
  strict: boolean
}

function usage(): string {
  return [
    'Usage: npm run replay:badcase -- --input <badcase-directory-or-json> [options]',
    '',
    'Options:',
    '  --input <path>',
    '  --output <directory>',
    '  --compare',
    '  --strict',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    output: path.resolve('..', 'outputs', 'phase-4-agent-evaluation', 'replay-run'),
    compare: false,
    strict: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--input') options.input = argv[++i]
    else if (arg === '--output') options.output = path.resolve(argv[++i] ?? '')
    else if (arg === '--compare') options.compare = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
    }
  }
  if (!options.input) {
    throw new Error(`Missing --input\n\n${usage()}`)
  }
  return options
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  process.env.MINI_CODE_MODEL_MODE = 'mock'
  process.env.MINI_CODE_HOME = path.join(options.output, '.mini-code-home')
  const result = await replayBadcase({
    input: options.input!,
    outputDir: options.output,
    compare: options.compare,
    strict: options.strict,
  })
  console.log(`Replay status: ${result.status}`)
  console.log(`Result: ${path.join(options.output, 'replay-result.json')}`)
  if (result.status === 'REPLAY_ERROR' || result.status === 'ENVIRONMENT_MISMATCH') {
    process.exit(2)
  }
  if (options.strict && result.status !== 'REPRODUCED') {
    process.exit(1)
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})
