import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PlannerRequest, ReplanRequest } from '../types.js'
import type { LivePlannerResult, PlannerTraceEvent } from './types.js'

function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/AUTH_TOKEN\s*[:=]\s*\S+/gi, 'AUTH_TOKEN=[REDACTED]')
    .replace(/API_KEY\s*[:=]\s*\S+/gi, 'API_KEY=[REDACTED]')
}

export async function savePlannerBadcase(args: {
  outputDir: string
  modelId: string
  caseId: string
  runId: string
  plannerContext: PlannerRequest | ReplanRequest
  result: LivePlannerResult
  trace?: PlannerTraceEvent[]
}): Promise<string> {
  const badcaseDir = path.join(args.outputDir, 'badcases', `${args.modelId}-${args.caseId}-${args.runId}`)
  await mkdir(badcaseDir, { recursive: true })
  await writeFile(path.join(badcaseDir, 'badcase.json'), `${JSON.stringify({
    schema_version: '1.0',
    model_id: args.modelId,
    case_id: args.caseId,
    run_id: args.runId,
    error_code: args.result.errorCode,
    replay_command: `npm run replay:planner-badcase -- --input ${badcaseDir}`,
  }, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(badcaseDir, 'planner-context.redacted.json'),
    `${redact(JSON.stringify(args.plannerContext, null, 2))}\n`,
    'utf8',
  )
  await writeFile(path.join(badcaseDir, 'response.redacted.txt'), redact(args.result.response.rawText), 'utf8')
  await writeFile(path.join(badcaseDir, 'validation-errors.json'), `${JSON.stringify(args.result.validation.errors, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'trace.jsonl'), (args.trace ?? []).map(event => JSON.stringify(event)).join('\n'), 'utf8')
  await writeFile(path.join(badcaseDir, 'replay.json'), `${JSON.stringify({
    mode: 'offline-response',
    response: 'response.redacted.txt',
  }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(badcaseDir, 'README.md'), [
    '# Planner Badcase',
    '',
    'This directory contains redacted offline replay material.',
    'Default replay reads response.redacted.txt and does not call a live model.',
    '',
  ].join('\n'), 'utf8')
  return badcaseDir
}
