import type { PlannerModelAdapter, PlannerModelRequest, PlannerModelResponse, PlannerUsage } from './types.js'

type AnthropicCompatibleAdapterOptions = {
  providerId: string
  modelId: string
  baseUrl: string
  authToken: string
  fetchImpl?: typeof fetch
  maxNetworkRetries?: number
  sleep?: (ms: number) => Promise<void>
}

type ProviderUsageShape = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function normalizeUsage(usage?: ProviderUsageShape): PlannerUsage | undefined {
  if (!usage) return undefined
  const cachedInputTokens = usage.cache_creation_input_tokens ?? usage.cache_read_input_tokens
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0)
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function extractText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        return String((block as { text?: unknown }).text ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractError(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const error = (data as { error?: unknown }).error
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
  }
  return `Planner model request failed: ${status}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

export class AnthropicCompatiblePlannerAdapter implements PlannerModelAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly maxNetworkRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: AnthropicCompatibleAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxNetworkRetries = options.maxNetworkRetries ?? 2
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async generatePlan(request: PlannerModelRequest): Promise<PlannerModelResponse> {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/messages`
    const body = {
      model: request.model,
      system: request.systemPrompt,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: JSON.stringify({
            plannerContext: request.plannerContext,
            taskPlanSchema: request.taskPlanSchema,
            repair: request.repair,
          }),
        }],
      }],
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
    }

    try {
      let lastData: unknown = {}
      let lastStatus = 0
      for (let attempt = 0; attempt <= this.maxNetworkRetries; attempt += 1) {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            Authorization: `Bearer ${this.options.authToken}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        lastStatus = response.status
        lastData = await readJson(response)
        if (response.ok) {
          const data = lastData as {
            stop_reason?: string
            usage?: ProviderUsageShape
          }
          return {
            providerId: request.providerId,
            modelId: request.modelId,
            rawText: extractText(lastData),
            finishReason: data.stop_reason,
            usage: normalizeUsage(data.usage),
            latencyMs: Date.now() - startedAt,
            requestId: request.requestId,
            attempt: request.attempt,
          }
        }
        if (!shouldRetryStatus(response.status) || attempt >= this.maxNetworkRetries) {
          break
        }
        await this.sleep(100 * Math.pow(2, attempt))
      }
      throw new Error(extractError(lastData, lastStatus))
    } finally {
      clearTimeout(timeout)
    }
  }
}
