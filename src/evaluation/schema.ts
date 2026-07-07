import type {
  AgentEvalCase,
  EvalCategory,
  EvalExpectations,
} from './types.js'
import { EVAL_SCHEMA_VERSION } from './types.js'

const CATEGORIES = new Set<EvalCategory>([
  'basic',
  'tool',
  'security',
  'compaction',
  'termination',
  'observability',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateExpectation(expectation: EvalExpectations): string[] {
  const errors: string[] = []
  const numberExpectations = [
    ['modelCallCount', expectation.modelCallCount],
    ['toolCallCount', expectation.toolCallCount],
  ] as const

  for (const [name, value] of numberExpectations) {
    if (value === undefined) continue
    const keys = Object.keys(value)
    if (keys.length !== 1 || !['equals', 'minimum', 'maximum', 'range'].includes(keys[0]!)) {
      errors.push(`${name} must contain exactly one numeric expectation operator`)
    }
  }

  if (expectation.roleSequenceMode && !['exact', 'subsequence', 'prefix'].includes(expectation.roleSequenceMode)) {
    errors.push('roleSequenceMode is invalid')
  }

  return errors
}

export function validateEvalCase(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ['case must be an object']
  }

  if (value.schemaVersion !== EVAL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EVAL_SCHEMA_VERSION}`)
  }
  for (const key of ['id', 'name', 'description'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      errors.push(`${key} is required`)
    }
  }
  if (typeof value.category !== 'string' || !CATEGORIES.has(value.category as EvalCategory)) {
    errors.push('category is invalid')
  }
  if (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string')) {
    errors.push('tags must be a string array')
  }
  if (!isRecord(value.input)) {
    errors.push('input is required')
  } else if (typeof value.input.userMessage !== 'string') {
    errors.push('input.userMessage is required')
  }
  if (!isRecord(value.expected)) {
    errors.push('expected is required')
  } else {
    errors.push(...validateExpectation(value.expected as EvalExpectations))
  }

  return errors
}

export function validateEvalCases(cases: AgentEvalCase[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const evalCase of cases) {
    errors.push(...validateEvalCase(evalCase).map(error => `${evalCase.id || '(missing id)'}: ${error}`))
    if (seen.has(evalCase.id)) {
      errors.push(`duplicate case id: ${evalCase.id}`)
    }
    seen.add(evalCase.id)
  }
  return errors
}
