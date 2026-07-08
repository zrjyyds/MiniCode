import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const workspace = path.resolve(process.argv[2] ?? process.cwd())
let buffer = Buffer.alloc(0)

function isWithinWorkspace(target: string): boolean {
  const relative = path.relative(workspace, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function countFiles(dir: string): Promise<number> {
  if (!isWithinWorkspace(dir)) {
    throw new Error('Path escapes acceptance workspace')
  }
  const entries = await readdir(dir, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (!isWithinWorkspace(full)) continue
    if (entry.isDirectory()) {
      count += await countFiles(full)
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}

async function projectSummary(): Promise<string> {
  const readme = path.join(workspace, 'README.md')
  if (!isWithinWorkspace(readme)) {
    throw new Error('README path escapes acceptance workspace')
  }
  const firstLine = (await readFile(readme, 'utf8')).split(/\r?\n/)[0] ?? ''
  const stats = await stat(workspace)
  return JSON.stringify({
    workspace,
    readmeFirstLine: firstLine,
    modifiedTime: stats.mtime.toISOString(),
  })
}

async function handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
  if (!message.id) return null
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'minicode-acceptance-mcp', version: '1.0.0' },
      },
    }
  }
  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'get_project_summary',
            description: 'Return a short summary for the acceptance workspace.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
          {
            name: 'count_workspace_files',
            description: 'Count files under the acceptance workspace.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
      },
    }
  }
  if (message.method === 'resources/list' || message.method === 'prompts/list') {
    return { jsonrpc: '2.0', id: message.id, result: message.method === 'resources/list' ? { resources: [] } : { prompts: [] } }
  }
  if (message.method === 'tools/call') {
    const params = message.params as { name?: string } | undefined
    if (params?.name === 'count_workspace_files') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: String(await countFiles(workspace)) }],
        },
      }
    }
    if (params?.name === 'get_project_summary') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: await projectSummary() }],
        },
      }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown tool' } }
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }
}

function send(message: JsonRpcMessage): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function processBuffer(): void {
  while (true) {
    const separator = buffer.indexOf('\r\n\r\n')
    if (separator === -1) return
    const header = buffer.subarray(0, separator).toString('utf8')
    const contentLength = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
    const bodyStart = separator + 4
    const bodyEnd = bodyStart + contentLength
    if (buffer.length < bodyEnd) return
    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8')
    buffer = buffer.subarray(bodyEnd)
    void handle(JSON.parse(body) as JsonRpcMessage)
      .then(response => {
        if (response) send(response)
      })
      .catch(error => {
        send({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
      })
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  processBuffer()
})
