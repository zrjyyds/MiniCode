import { spawn } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const script = path.join(root, 'scripts', 'debug-agent-loop.ts')

type SpawnResult = {
  code: number
  stdout: string
  stderr: string
}

async function runCli(args: string[]): Promise<SpawnResult> {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', script, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          MINI_CODE_MODEL_MODE: 'mock',
        },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('exit', code => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function tempOutput(name: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'minicode-cli-test-'))
  return path.join(rootDir, name)
}

describe('debug agent loop CLI', () => {
  it('lists scenarios', async () => {
    const result = await runCli(['--list-scenarios'])

    assert.equal(result.code, 0)
    assert.match(result.stdout, /simple-answer/)
    assert.match(result.stdout, /compaction-observation/)
  })

  it('runs a legal scenario and creates trace outputs', async () => {
    const output = await tempOutput('simple')
    const result = await runCli([
      '--scenario', 'simple-answer',
      '--output', output,
      '--trace-mode', 'summary',
    ])

    assert.equal(result.code, 0, result.stderr)
    await stat(path.join(output, 'trace.jsonl'))
    await stat(path.join(output, 'trace-summary.md'))
    await stat(path.join(output, 'snapshots'))
  })

  it('rejects unknown scenarios', async () => {
    const result = await runCli([
      '--scenario', 'does-not-exist',
      '--output', await tempOutput('bad'),
    ])

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Unknown or missing scenario/)
  })

  it('rejects invalid trace modes', async () => {
    const result = await runCli([
      '--scenario', 'simple-answer',
      '--trace-mode', 'verbose',
      '--output', await tempOutput('bad-mode'),
    ])

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Invalid trace mode/)
  })
})
