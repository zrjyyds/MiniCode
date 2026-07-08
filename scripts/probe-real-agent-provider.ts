import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  canProbeRealProvider,
  loadRealAgentConfig,
  probeRealProvider,
  renderProviderCompatibility,
  resolveRealAgentConfig,
  skippedProbeRows,
} from '../src/real-agent/index.js'

type Args = {
  config?: string
  output: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    output: path.resolve('..', 'outputs', 'phase-8-real-agent-e2e'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--config') args.config = next()
    else if (arg === '--output') args.output = next()
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.config) {
  console.error('Missing required --config <path>')
  process.exit(1)
}

const configPath = path.resolve(args.config)
const outputDir = path.resolve(args.output)
await mkdir(outputDir, { recursive: true })
const config = await loadRealAgentConfig(configPath)
const rows = canProbeRealProvider(config)
  ? await probeRealProvider(resolveRealAgentConfig(config, configPath))
  : skippedProbeRows('required MINICODE_REAL_* environment variables are missing')

await writeFile(path.join(outputDir, 'PROVIDER_COMPATIBILITY.md'), renderProviderCompatibility(rows), 'utf8')
await writeFile(path.join(outputDir, 'provider-compatibility.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
console.log(`Provider compatibility rows: ${rows.length}`)
console.log(`Output: ${outputDir}`)
