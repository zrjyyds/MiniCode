import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import { readFileTool } from '../src/tools/read-file.js'
import { listFilesTool } from '../src/tools/list-files.js'
import { runCommandTool } from '../src/tools/run-command.js'
import { MultiAgentOrchestrator } from '../src/multi-agent/orchestrator.js'
import { MULTI_AGENT_SCENARIOS } from '../src/evaluation/multi-agent.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--list-scenarios')) {
  console.log(MULTI_AGENT_SCENARIOS.map(scenario => scenario.id).join('\n'))
  process.exit(0)
}

const scenario = arg('--scenario') ?? 'simple-plan'
const scenarioDef = MULTI_AGENT_SCENARIOS.find(item => item.id === scenario)
if (!scenarioDef) {
  console.error(`Unknown scenario: ${scenario}`)
  process.exit(2)
}
const outputDir = path.resolve(arg('--output') ?? '..', arg('--output') ? '' : 'outputs/phase-6-planner-executor/debug')
const maxSteps = Number(arg('--max-steps') ?? '0')
const maxReplans = arg('--max-replans') ? Number(arg('--max-replans')) : undefined
const maxToolCalls = arg('--max-tool-calls') ? Number(arg('--max-tool-calls')) : undefined
if (maxSteps < 0 || (maxReplans != null && maxReplans > 10) || (maxToolCalls != null && maxToolCalls > 100)) {
  console.error('Invalid debug budget argument')
  process.exit(2)
}

const tools = new ToolRegistry([readFileTool, listFilesTool, runCommandTool])
const state = await new MultiAgentOrchestrator({
  objective: scenarioDef.objective,
  cwd: process.cwd(),
  outputDir,
  tools,
  scenario,
  resume: arg('--resume'),
  stopAfterSteps: maxSteps || undefined,
  budgets: { maxReplans, maxToolCalls },
}).run()

if (process.argv.includes('--print-plan')) {
  console.log(JSON.stringify(state.currentPlan, null, 2))
}
if (process.argv.includes('--print-state')) {
  console.log(JSON.stringify(state, null, 2))
}
console.log(`Multi-agent run ${state.runId}: ${state.status}`)
process.exit(['completed', 'budget_exceeded'].includes(state.status) ? 0 : 1)
