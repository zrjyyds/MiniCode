function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .slice(0, 240)
}

async function readJsonError(response: Response): Promise<string> {
  const text = await response.text()
  if (!text.trim()) return `HTTP ${response.status}`
  try {
    const data = JSON.parse(text) as unknown
    if (data && typeof data === 'object') {
      const error = (data as { error?: unknown }).error
      if (error && typeof error === 'object') {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message.trim()) return redactError(message)
      }
      const message = (data as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return redactError(message)
    }
  } catch {
    // Fall through to a status-only diagnostic. The raw body may be provider text.
  }
  return `HTTP ${response.status}`
}

export type SseJsonEvent = {
  data: unknown
}

function parseSseEvent(rawEvent: string): SseJsonEvent | 'done' | null {
  const dataLines: string[] = []
  for (const line of rawEvent.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      const data = line.slice('data:'.length)
      dataLines.push(data.startsWith(' ') ? data.slice(1) : data)
    }
  }
  if (dataLines.length === 0) return null
  const data = dataLines.join('\n').trim()
  if (data === '[DONE]') return 'done'
  try {
    return { data: JSON.parse(data) as unknown }
  } catch (error) {
    throw new Error(`Invalid SSE JSON event: ${redactError(error instanceof Error ? error.message : String(error))}`)
  }
}

function normalizeSseBuffer(buffer: string): string {
  // A chunk may end between CR and LF. Preserve the trailing CR so the next
  // chunk can form one CRLF instead of two LF characters and a false boundary.
  const trailingCr = buffer.endsWith('\r')
  const body = trailingCr ? buffer.slice(0, -1) : buffer
  return `${body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')}${trailingCr ? '\r' : ''}`
}

export async function readSseJsonEvents(response: Response): Promise<SseJsonEvent[]> {
  if (!response.ok) {
    throw new Error(`SSE request failed: ${await readJsonError(response)}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    throw new Error(`Expected text/event-stream response, received ${contentType || 'missing content-type'}`)
  }
  if (!response.body) {
    throw new Error('SSE response body is missing')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: SseJsonEvent[] = []
  let buffer = ''
  let sawDone = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = normalizeSseBuffer(buffer)

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseEvent(rawEvent)
        if (event === 'done') {
          sawDone = true
          break
        }
        if (event) events.push(event)
        boundary = buffer.indexOf('\n\n')
      }
      if (sawDone) break
    }
  } catch (error) {
    throw new Error(`SSE stream read failed: ${redactError(error instanceof Error ? error.message : String(error))}`)
  } finally {
    reader.releaseLock()
  }

  if (!sawDone) {
    throw new Error('SSE stream ended before [DONE]')
  }
  return events
}
