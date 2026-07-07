import path from 'node:path'
import { DockerSandboxExecutor } from '../src/execution/docker-sandbox-executor.js'
import {
  buildDockerRunSpec,
  defaultDockerSandboxConfig,
  validateDockerRunArgs,
} from '../src/execution/docker-command-builder.js'

type Args = {
  command: string
  workspace: string
  timeout?: number
  memory?: string
  cpus?: string
  pids?: number
  maxOutput?: number
  output: string
  keepWorkspace: boolean
  printDockerArgs: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'node --version',
    workspace: process.cwd(),
    output: path.resolve('..', 'outputs', 'phase-5-docker-sandbox', 'debug'),
    keepWorkspace: false,
    printDockerArgs: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--command') args.command = argv[++i] ?? args.command
    else if (value === '--workspace') args.workspace = argv[++i] ?? args.workspace
    else if (value === '--timeout') args.timeout = Number(argv[++i])
    else if (value === '--memory') args.memory = argv[++i]
    else if (value === '--cpus') args.cpus = argv[++i]
    else if (value === '--pids') args.pids = Number(argv[++i])
    else if (value === '--max-output') args.maxOutput = Number(argv[++i])
    else if (value === '--output') args.output = path.resolve(argv[++i] ?? args.output)
    else if (value === '--keep-workspace') args.keepWorkspace = true
    else if (value === '--print-docker-args') args.printDockerArgs = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const config = defaultDockerSandboxConfig(path.join(args.output, 'runtime'))
if (args.memory) config.resources.memory = args.memory
if (args.cpus) config.resources.cpus = args.cpus
if (args.pids) config.resources.pidsLimit = args.pids
if (args.maxOutput && args.maxOutput > config.maxOutputBytes) {
  console.error(`Sandbox config error: --max-output exceeds ${config.maxOutputBytes}`)
  process.exit(2)
}
if (args.timeout && args.timeout > config.maxTimeoutMs) {
  console.error(`Sandbox config error: --timeout exceeds ${config.maxTimeoutMs}`)
  process.exit(2)
}

if (args.printDockerArgs) {
  const spec = buildDockerRunSpec({
    config,
    runId: 'debug-print',
    workspacePath: path.join(config.runtimeRoot, 'debug-print', 'workspace'),
    command: args.command,
  })
  validateDockerRunArgs(spec.args, config.runtimeRoot)
  console.log(spec.args.join(' '))
  process.exit(0)
}

if (args.keepWorkspace) {
  process.env.MINI_CODE_KEEP_SANDBOX_WORKSPACE = '1'
}

const executor = new DockerSandboxExecutor(config)
const result = await executor.execute({
  command: 'sh',
  args: ['-lc', args.command],
  workingDirectory: path.resolve(args.workspace),
  timeoutMs: args.timeout,
  maxOutputBytes: args.maxOutput,
  useShell: true,
})

console.log(JSON.stringify({
  backend: result.backend,
  exitCode: result.exitCode,
  errorCode: result.errorCode,
  timedOut: result.timedOut,
  cleanupStatus: result.cleanupStatus,
  containerName: result.containerName,
}, null, 2))
if (result.stdout) console.log(result.stdout)
if (result.stderr) console.error(result.stderr)
process.exit(result.errorCode ? 1 : 0)
