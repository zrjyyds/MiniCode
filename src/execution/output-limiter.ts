import { StringDecoder } from 'node:string_decoder'

export type LimitedOutput = {
  text: string
  truncated: boolean
  capturedBytes: number
  totalObservedBytes: number
}

export class OutputLimiter {
  private readonly chunks: Buffer[] = []
  private observed = 0
  private captured = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive integer')
    }
  }

  push(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.observed += buffer.length
    const remaining = this.maxBytes - this.captured
    if (remaining <= 0) {
      this.truncated = true
      return
    }

    const accepted = buffer.subarray(0, remaining)
    this.chunks.push(accepted)
    this.captured += accepted.length
    if (accepted.length < buffer.length) {
      this.truncated = true
    }
  }

  result(): LimitedOutput {
    const raw = Buffer.concat(this.chunks, this.captured)
    const decoder = new StringDecoder('utf8')
    let text = decoder.write(raw)
    text += decoder.end()

    if (this.truncated) {
      text = `${text}\n[output truncated]\ncaptured_bytes=${this.captured}\ntotal_observed_bytes=${this.observed}`
    }

    return {
      text,
      truncated: this.truncated,
      capturedBytes: this.captured,
      totalObservedBytes: this.observed,
    }
  }
}

export function limitOutput(value: string | Buffer, maxBytes: number): LimitedOutput {
  const limiter = new OutputLimiter(maxBytes)
  limiter.push(value)
  return limiter.result()
}
