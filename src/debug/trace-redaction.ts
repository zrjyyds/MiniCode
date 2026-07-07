const SENSITIVE_KEY_PARTS = [
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'password',
  'passwd',
  'secret',
]

const SENSITIVE_EXACT_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'anthropic_auth_token',
  'openai_api_key',
  'aws_secret_access_key',
  'github_token',
])

const SAFE_TOKEN_STAT_KEYS = new Set([
  'token_count',
  'token_counts',
  'tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'max_tokens',
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'maxTokens',
])

const REDACTED = '[REDACTED]'

function normalizeKey(key: string): string {
  return key.replace(/[-\s]/g, '_').toLowerCase()
}

export function isSensitiveKey(key: string): boolean {
  if (SAFE_TOKEN_STAT_KEYS.has(key)) return false
  const normalized = normalizeKey(key)
  if (SAFE_TOKEN_STAT_KEYS.has(normalized)) return false
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true
  return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part))
}

function redactString(value: string): string {
  return value
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, `$1${REDACTED}`)
    .replace(
      /\b(ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)\s*=\s*([^\s\r\n]+)/g,
      `$1=${REDACTED}`,
    )
}

export function redactTraceValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && isSensitiveKey(keyHint)) {
    return REDACTED
  }

  if (typeof value === 'string') {
    return redactString(value)
  }

  if (value === null || value === undefined) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => redactTraceValue(item))
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactTraceValue(child, key)
    }
    return result
  }

  return value
}

export { REDACTED }
