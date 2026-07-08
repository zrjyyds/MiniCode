import type { TaskPlan } from './types.js'

export type PlannerParseErrorCode =
  | 'PLANNER_EMPTY_RESPONSE'
  | 'PLANNER_OUTPUT_TOO_LARGE'
  | 'PLANNER_JSON_NOT_FOUND'
  | 'PLANNER_JSON_PARSE_FAILED'
  | 'PLANNER_MULTIPLE_JSON_OBJECTS'
  | 'PLANNER_SCHEMA_INVALID'
  | 'PLANNER_PLAN_REJECTED'

export class PlannerOutputParseError extends Error {
  constructor(
    readonly code: PlannerParseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PlannerOutputParseError'
  }
}

export type PlannerOutputParserOptions = {
  maxBytes?: number
  maxDepth?: number
}

export type PlannerOutputParseResult = {
  plan: TaskPlan
  source: 'direct-json' | 'json-code-block' | 'embedded-json'
}

const DEFAULT_MAX_BYTES = 128 * 1024
const DEFAULT_MAX_DEPTH = 40

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new PlannerOutputParseError(
      'PLANNER_JSON_PARSE_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function maxJsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(maxJsonDepth))
  }
  return 1 + Math.max(0, ...Object.values(value as Record<string, unknown>).map(maxJsonDepth))
}

function assertTaskPlanShape(value: unknown, maxDepth: number): TaskPlan {
  if (maxJsonDepth(value) > maxDepth) {
    throw new PlannerOutputParseError('PLANNER_SCHEMA_INVALID', 'Planner JSON exceeds max depth.')
  }
  if (!value || typeof value !== 'object') {
    throw new PlannerOutputParseError('PLANNER_SCHEMA_INVALID', 'Planner output must be an object.')
  }
  const plan = value as Partial<TaskPlan>
  if (
    typeof plan.schemaVersion !== 'string' ||
    typeof plan.planId !== 'string' ||
    typeof plan.objective !== 'string' ||
    !Array.isArray(plan.assumptions) ||
    !Array.isArray(plan.constraints) ||
    !Array.isArray(plan.successCriteria) ||
    !Array.isArray(plan.steps) ||
    typeof plan.createdAt !== 'string' ||
    typeof plan.revision !== 'number'
  ) {
    throw new PlannerOutputParseError('PLANNER_SCHEMA_INVALID', 'Planner output is missing TaskPlan fields.')
  }
  return plan as TaskPlan
}

function extractJsonCodeBlocks(text: string): string[] {
  const blocks: string[] = []
  const pattern = /```(?:json|JSON)?\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1]?.trim()
    if (body) blocks.push(body)
  }
  return blocks
}

function findBalancedObjects(text: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return objects
}

function parseCandidate(
  text: string,
  source: PlannerOutputParseResult['source'],
  maxDepth: number,
): PlannerOutputParseResult {
  const value = tryJsonParse(text)
  return {
    plan: assertTaskPlanShape(value, maxDepth),
    source,
  }
}

export function parsePlannerOutput(
  rawText: string,
  options: PlannerOutputParserOptions = {},
): PlannerOutputParseResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const text = rawText.trim()
  if (!text) {
    throw new PlannerOutputParseError('PLANNER_EMPTY_RESPONSE', 'Planner response is empty.')
  }
  if (byteLength(text) > maxBytes) {
    throw new PlannerOutputParseError('PLANNER_OUTPUT_TOO_LARGE', 'Planner response exceeds max bytes.')
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    return parseCandidate(text, 'direct-json', maxDepth)
  }

  const codeBlocks = extractJsonCodeBlocks(text)
  if (codeBlocks.length > 1) {
    throw new PlannerOutputParseError('PLANNER_MULTIPLE_JSON_OBJECTS', 'Planner response contains multiple JSON code blocks.')
  }
  if (codeBlocks.length === 1) {
    return parseCandidate(codeBlocks[0], 'json-code-block', maxDepth)
  }

  const objects = findBalancedObjects(text)
  if (objects.length === 0) {
    if (text.includes('{')) {
      throw new PlannerOutputParseError('PLANNER_JSON_PARSE_FAILED', 'Planner response contains truncated JSON.')
    }
    throw new PlannerOutputParseError('PLANNER_JSON_NOT_FOUND', 'Planner response does not contain JSON.')
  }
  if (objects.length > 1) {
    throw new PlannerOutputParseError('PLANNER_MULTIPLE_JSON_OBJECTS', 'Planner response contains multiple JSON objects.')
  }
  return parseCandidate(objects[0], 'embedded-json', maxDepth)
}
