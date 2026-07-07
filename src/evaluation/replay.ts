import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvalCase, ReplayResult } from './types.js'
import { EVAL_SCHEMA_VERSION } from './types.js'
import { runEvaluation } from './runner.js'

type BadcaseFile = {
  schema_version: string
  case_id: string
  failure_stage?: string
  failed_assertions?: Array<{ id?: string }>
}

async function resolveBadcaseJson(input: string): Promise<string> {
  const resolved = path.resolve(input)
  const info = await stat(resolved)
  return info.isDirectory() ? path.join(resolved, 'badcase.json') : resolved
}

export async function replayBadcase(args: {
  input: string
  outputDir: string
  compare?: boolean
  strict?: boolean
  overrideCase?: AgentEvalCase
}): Promise<ReplayResult> {
  await mkdir(args.outputDir, { recursive: true })
  try {
    const badcasePath = await resolveBadcaseJson(args.input)
    const badcase = JSON.parse(await readFile(badcasePath, 'utf8')) as BadcaseFile
    if (badcase.schema_version !== EVAL_SCHEMA_VERSION) {
      return {
        schemaVersion: EVAL_SCHEMA_VERSION,
        status: 'REPLAY_ERROR',
        originalCaseId: badcase.case_id ?? 'unknown',
        compared: Boolean(args.compare),
        reasons: ['badcase schema mismatch'],
      }
    }

    const inputPath = path.join(path.dirname(badcasePath), 'input.json')
    const evalCase = args.overrideCase ?? JSON.parse(await readFile(inputPath, 'utf8')) as AgentEvalCase
    const summary = await runEvaluation({
      outputDir: args.outputDir,
      cases: [evalCase],
      savePassedTraces: true,
    })
    const replayed = summary.results[0]
    if (!replayed) {
      throw new Error('Replay produced no result.')
    }

    const originalFailedAssertions = new Set((badcase.failed_assertions ?? []).map(item => item.id).filter(Boolean))
    const replayFailedAssertions = new Set(replayed.assertions.filter(item => !item.passed).map(item => item.id))
    const sameFailureStage = String(badcase.failure_stage ?? '') === String(replayed.failureStage ?? replayed.observedFailureStage ?? '')
    const sameAssertions = [...originalFailedAssertions].every(id => replayFailedAssertions.has(String(id)))
    const reproduced = replayed.status !== 'passed' && (!args.compare || (sameFailureStage && sameAssertions))
    const status = reproduced
      ? 'REPRODUCED'
      : replayed.status === 'passed'
        ? 'RESOLVED'
        : 'NOT_REPRODUCED'

    const result: ReplayResult = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      status,
      originalCaseId: badcase.case_id,
      replayedCaseId: replayed.caseId,
      originalFailureStage: badcase.failure_stage as ReplayResult['originalFailureStage'],
      replayFailureStage: replayed.failureStage ?? replayed.observedFailureStage,
      compared: Boolean(args.compare),
      outputDir: args.outputDir,
      reasons: reproduced
        ? ['failure reproduced']
        : [`replay status=${replayed.status}`, `sameFailureStage=${sameFailureStage}`, `sameAssertions=${sameAssertions}`],
    }
    await writeFile(path.join(args.outputDir, 'replay-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    const result: ReplayResult = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      status: 'REPLAY_ERROR',
      originalCaseId: 'unknown',
      compared: Boolean(args.compare),
      outputDir: args.outputDir,
      reasons: [error instanceof Error ? error.message : String(error)],
    }
    await writeFile(path.join(args.outputDir, 'replay-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }
}
