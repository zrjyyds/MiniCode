import type { RealAgentConfig, ResolvedRealAgentConfig } from './config.js'

export type ProviderProbeRow = {
  protocol: 'Anthropic Messages' | 'OpenAI Responses' | 'OpenAI Chat Completions'
  result: 'supported' | 'unsupported' | 'skipped' | 'auth_failed' | 'rate_limited' | 'error'
  statusCode: number | 'n/a'
  supportsText: boolean | 'unknown'
  supportsTools: boolean | 'unknown'
  error?: string
}

type ProbeEndpoint = {
  rowProtocol: ProviderProbeRow['protocol']
  path: string
  headers: (apiKey: string) => Record<string, string>
  body: (model: string) => unknown
  textSupported: (data: unknown) => boolean
}

const PROBES: ProbeEndpoint[] = [
  {
    rowProtocol: 'Anthropic Messages',
    path: '/v1/messages',
    headers: apiKey => ({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    }),
    body: model => ({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
      max_tokens: 8,
    }),
    textSupported: data =>
      Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as { content?: unknown }).content),
      ),
  },
  {
    rowProtocol: 'OpenAI Responses',
    path: '/v1/responses',
    headers: apiKey => ({
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
    body: model => ({
      model,
      input: 'Reply OK.',
      max_output_tokens: 8,
    }),
    textSupported: data =>
      Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as { output?: unknown }).output),
      ),
  },
  {
    rowProtocol: 'OpenAI Chat Completions',
    path: '/v1/chat/completions',
    headers: apiKey => ({
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
    body: model => ({
      model,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: 8,
    }),
    textSupported: data =>
      Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as { choices?: unknown }).choices),
      ),
  },
]

function envPresent(name: string): boolean {
  return Boolean(process.env[name]?.trim())
}

function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 500)
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: { message: text.trim() } }
  }
}

function extractError(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const error = (data as { error?: unknown }).error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return redactError(message)
  }
  const message = (data as { message?: unknown }).message
  return typeof message === 'string' ? redactError(message) : undefined
}

export function canProbeRealProvider(config: RealAgentConfig): boolean {
  return envPresent(config.baseUrlEnv) && envPresent(config.modelEnv) && envPresent(config.apiKeyEnv)
}

export function skippedProbeRows(reason: string): ProviderProbeRow[] {
  return PROBES.map(probe => ({
    protocol: probe.rowProtocol,
    result: 'skipped',
    statusCode: 'n/a',
    supportsText: 'unknown',
    supportsTools: 'unknown',
    error: reason,
  }))
}

export async function probeRealProvider(
  config: ResolvedRealAgentConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderProbeRow[]> {
  const rows: ProviderProbeRow[] = []
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  for (const probe of PROBES) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 15000))
    try {
      const response = await fetchImpl(`${baseUrl}${probe.path}`, {
        method: 'POST',
        headers: probe.headers(config.apiKey),
        body: JSON.stringify(probe.body(config.model)),
        signal: controller.signal,
      })
      const data = await readJson(response)
      const supportsText = response.ok && probe.textSupported(data)
      const result: ProviderProbeRow['result'] =
        response.status === 401 || response.status === 403
          ? 'auth_failed'
          : response.status === 429
            ? 'rate_limited'
            : supportsText
              ? 'supported'
              : 'unsupported'
      rows.push({
        protocol: probe.rowProtocol,
        result,
        statusCode: response.status,
        supportsText,
        supportsTools: supportsText ? 'unknown' : false,
        error: response.ok ? undefined : extractError(data),
      })
      if (response.status === 401 || response.status === 403) break
    } catch (error) {
      rows.push({
        protocol: probe.rowProtocol,
        result: 'error',
        statusCode: 'n/a',
        supportsText: false,
        supportsTools: false,
        error: redactError(error instanceof Error ? error.message : String(error)),
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  return rows
}

export function renderProviderCompatibility(rows: ProviderProbeRow[]): string {
  return [
    '# Provider Compatibility',
    '',
    '| 协议 | 结果 | 状态码 | 是否支持文本 | 是否支持工具 |',
    '|---|---|---:|---|---|',
    ...rows.map(row => `| ${row.protocol} | ${row.result}${row.error ? ` (${row.error})` : ''} | ${row.statusCode} | ${row.supportsText} | ${row.supportsTools} |`),
    '',
  ].join('\n')
}
