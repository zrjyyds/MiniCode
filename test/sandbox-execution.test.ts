import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowedSandboxEnvironment,
  buildDockerRunSpec,
  defaultDockerSandboxConfig,
  validateDockerRunArgs,
} from '../src/execution/docker-command-builder.js'
import { DockerSandboxExecutor } from '../src/execution/docker-sandbox-executor.js'
import { HostCommandExecutor } from '../src/execution/host-command-executor.js'
import { createCommandExecutor, selectCommandExecutorName } from '../src/execution/index.js'
import { limitOutput, OutputLimiter } from '../src/execution/output-limiter.js'
import { createWorkspaceSnapshot, snapshotExists } from '../src/execution/workspace-snapshot.js'
import { SANDBOX_EVAL_CASES, runSandboxEvaluation } from '../src/evaluation/sandbox.js'
import type { DockerCliRunner } from '../src/execution/types.js'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-sandbox-test-'))
}

function config(runtimeRoot: string) {
  return defaultDockerSandboxConfig(runtimeRoot)
}

describe('command executor selection', () => {
  it('defaults to host', () => {
    assert.equal(selectCommandExecutorName(undefined), 'host')
    assert.equal(createCommandExecutor({ name: 'host' }).backend, 'host')
  })

  it('selects docker explicitly', async () => {
    const runtimeRoot = await tempDir()
    assert.equal(selectCommandExecutorName('docker'), 'docker')
    assert.equal(createCommandExecutor({ name: 'docker', runtimeRoot }).backend, 'docker')
  })

  it('rejects unknown executor names', () => {
    assert.throws(() => selectCommandExecutorName('vm'), /Unknown command executor/)
  })

  it('keeps host executor behavior for successful commands', async () => {
    const result = await new HostCommandExecutor().execute({
      command: process.execPath,
      args: ['-e', 'console.log("host-ok")'],
      workingDirectory: process.cwd(),
    })
    assert.equal(result.backend, 'host')
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /host-ok/)
  })
})

describe('docker command builder', () => {
  it('builds docker args as an argv array', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'Run ID With Spaces',
      workspacePath: path.join(runtimeRoot, 'run id', 'workspace'),
      command: 'node --version',
    })
    assert.ok(Array.isArray(spec.args))
    assert.ok(spec.args.includes('--network'))
    assert.ok(spec.args.includes('none'))
    assert.match(spec.containerName, /^minicode-sandbox-/)
  })

  it('requires network none', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'network',
      workspacePath: path.join(runtimeRoot, 'network', 'workspace'),
      command: 'node --version',
    })
    validateDockerRunArgs(spec.args, runtimeRoot)
  })

  it('rejects fault injected network bridge', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'bad-network',
      workspacePath: path.join(runtimeRoot, 'bad-network', 'workspace'),
      command: 'node --version',
      faultInjection: 'omit-network-none',
    })
    assert.throws(() => validateDockerRunArgs(spec.args, runtimeRoot), /network none/)
  })

  it('rejects privileged containers', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'privileged',
      workspacePath: path.join(runtimeRoot, 'privileged', 'workspace'),
      command: 'node --version',
    })
    assert.throws(() => validateDockerRunArgs([...spec.args, '--privileged'], runtimeRoot), /Forbidden/)
  })

  it('rejects docker socket mounts', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'socket',
      workspacePath: path.join(runtimeRoot, 'socket', 'workspace'),
      command: 'node --version',
    })
    assert.throws(
      () => validateDockerRunArgs([...spec.args, '--mount', 'type=bind,src=/var/run/docker.sock,dst=/sock'], runtimeRoot),
      /docker.sock/,
    )
  })

  it('rejects mounts outside runtime root', async () => {
    const runtimeRoot = await tempDir()
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'outside',
      workspacePath: os.tmpdir(),
      command: 'node --version',
    })
    assert.throws(() => validateDockerRunArgs(spec.args, runtimeRoot), /escapes allowed root/)
  })

  it('keeps spaces and special characters inside separated args', async () => {
    const runtimeRoot = await tempDir()
    const workspacePath = path.join(runtimeRoot, 'space dir', 'workspace')
    const spec = buildDockerRunSpec({
      config: config(runtimeRoot),
      runId: 'quoted',
      workspacePath,
      command: 'echo "hello world"',
    })
    assert.ok(spec.args.some(arg => arg.includes('space dir')))
    assert.equal(spec.args.at(-1), 'echo "hello world"')
  })
})

describe('sandbox environment allowlist', () => {
  it('keeps allowed variables', () => {
    const env = allowedSandboxEnvironment({ TERM: 'xterm', LANG: 'C.UTF-8' })
    assert.equal(env.TERM, 'xterm')
    assert.equal(env.LANG, 'C.UTF-8')
  })

  it('does not forward token variables', () => {
    const env = allowedSandboxEnvironment({
      OPENAI_API_KEY: 'sk-test',
      GITHUB_TOKEN: 'ghp-test',
      MINICODE_TEST_SECRET: 'secret',
    })
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.equal(env.MINICODE_TEST_SECRET, undefined)
  })

  it('does not mutate the input environment object', () => {
    const source = { TERM: 'xterm' }
    allowedSandboxEnvironment(source)
    assert.deepEqual(source, { TERM: 'xterm' })
  })
})

describe('workspace snapshot', () => {
  it('copies ordinary files and records metadata', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    await writeFile(path.join(source, 'README.md'), 'hello\n', 'utf8')
    const snapshot = await createWorkspaceSnapshot({
      sourceDirectory: source,
      runtimeRoot,
      runId: 'copy',
      maxBytes: 1024,
      maxFiles: 10,
    })
    assert.equal(snapshot.fileCount, 1)
    assert.equal(await readFile(path.join(snapshot.workspacePath, 'README.md'), 'utf8'), 'hello\n')
    assert.equal(await snapshotExists(snapshot.workspacePath), true)
  })

  it('excludes .env and secret-like files', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    await writeFile(path.join(source, '.env'), 'TOKEN=secret\n', 'utf8')
    await writeFile(path.join(source, 'api.key'), 'secret\n', 'utf8')
    await writeFile(path.join(source, 'ok.txt'), 'ok\n', 'utf8')
    const snapshot = await createWorkspaceSnapshot({
      sourceDirectory: source,
      runtimeRoot,
      runId: 'exclude',
      maxBytes: 1024,
      maxFiles: 10,
    })
    assert.equal(snapshot.fileCount, 1)
    assert.ok(snapshot.skipped.includes('.env'))
    assert.ok(snapshot.skipped.includes('api.key'))
  })

  it('excludes .git and node_modules directories', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    await writeFile(path.join(source, 'package.json'), '{}\n', 'utf8')
    await writeFile(path.join(source, '.git'), 'not-a-directory\n', 'utf8')
    const snapshot = await createWorkspaceSnapshot({
      sourceDirectory: source,
      runtimeRoot,
      runId: 'git',
      maxBytes: 1024,
      maxFiles: 10,
    })
    assert.equal(snapshot.fileCount, 1)
  })

  it('enforces byte limits', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    await writeFile(path.join(source, 'large.txt'), 'x'.repeat(20), 'utf8')
    await assert.rejects(
      createWorkspaceSnapshot({
        sourceDirectory: source,
        runtimeRoot,
        runId: 'large',
        maxBytes: 10,
        maxFiles: 10,
      }),
      /Snapshot byte limit exceeded/,
    )
  })

  it('enforces file count limits', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    await writeFile(path.join(source, 'a.txt'), 'a', 'utf8')
    await writeFile(path.join(source, 'b.txt'), 'b', 'utf8')
    await assert.rejects(
      createWorkspaceSnapshot({
        sourceDirectory: source,
        runtimeRoot,
        runId: 'many',
        maxBytes: 1024,
        maxFiles: 1,
      }),
      /Snapshot file limit exceeded/,
    )
  })

  it('does not follow escaping symlinks', async () => {
    const source = await tempDir()
    const runtimeRoot = await tempDir()
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    await writeFile(outside, 'outside', 'utf8')
    try {
      await symlink(outside, path.join(source, 'outside-link'))
    } catch {
      return
    }
    const snapshot = await createWorkspaceSnapshot({
      sourceDirectory: source,
      runtimeRoot,
      runId: 'symlink',
      maxBytes: 1024,
      maxFiles: 10,
    })
    assert.equal(snapshot.fileCount, 0)
    assert.ok(snapshot.skipped.some(item => item.includes('outside-link')))
  })
})

describe('output limiter', () => {
  it('passes small output through', () => {
    const result = limitOutput('hello', 10)
    assert.equal(result.text, 'hello')
    assert.equal(result.truncated, false)
  })

  it('truncates large stdout', () => {
    const result = limitOutput('x'.repeat(20), 10)
    assert.equal(result.truncated, true)
    assert.match(result.text, /output truncated/)
    assert.equal(result.totalObservedBytes, 20)
  })

  it('tracks incremental output without unbounded capture', () => {
    const limiter = new OutputLimiter(5)
    limiter.push('abc')
    limiter.push('def')
    const result = limiter.result()
    assert.equal(result.capturedBytes, 5)
    assert.equal(result.totalObservedBytes, 6)
  })

  it('handles utf8 boundaries without throwing', () => {
    const result = limitOutput('你好世界', 5)
    assert.equal(result.truncated, true)
    assert.match(result.text, /output truncated/)
  })
})

describe('docker sandbox executor', () => {
  it('returns SANDBOX_UNAVAILABLE without host fallback', async () => {
    const runtimeRoot = await tempDir()
    const source = await tempDir()
    await writeFile(path.join(source, 'marker.txt'), 'host must not run', 'utf8')
    const runner: DockerCliRunner = async () => {
      throw new Error('docker missing')
    }
    const result = await new DockerSandboxExecutor(config(runtimeRoot), runner).execute({
      command: process.execPath,
      args: ['-e', 'process.exit(77)'],
      workingDirectory: source,
      runId: 'unavailable',
    })
    assert.equal(result.errorCode, 'SANDBOX_UNAVAILABLE')
    assert.equal(result.exitCode, null)
  })

  it('records sandbox trace events in order', async () => {
    const runtimeRoot = await tempDir()
    const source = await tempDir()
    await writeFile(path.join(source, 'README.md'), 'ok\n', 'utf8')
    const events: string[] = []
    const runner: DockerCliRunner = async args => {
      if (args[0] === 'version') {
        return dockerResult(0, '24.0.0\n')
      }
      return dockerResult(0, 'container-ok\n')
    }
    const result = await new DockerSandboxExecutor(config(runtimeRoot), runner).execute({
      command: 'node',
      args: ['--version'],
      workingDirectory: source,
      runId: 'trace',
      trace: { onEvent(event) { events.push(String(event.event_type)) } },
    })
    assert.equal(result.exitCode, 0)
    assert.ok(events.includes('sandbox_requested'))
    assert.ok(events.includes('sandbox_workspace_created'))
    assert.ok(events.includes('sandbox_command_completed'))
  })

  it('marks command timeout from docker runner result', async () => {
    const runtimeRoot = await tempDir()
    const source = await tempDir()
    const runner: DockerCliRunner = async args => {
      if (args[0] === 'version') return dockerResult(0, '24')
      return { ...dockerResult(124, '', 'timeout'), timedOut: true }
    }
    const result = await new DockerSandboxExecutor(config(runtimeRoot), runner).execute({
      command: 'node',
      args: ['-e', 'setTimeout(()=>{}, 10000)'],
      workingDirectory: source,
      runId: 'timeout',
    })
    assert.equal(result.errorCode, 'COMMAND_TIMEOUT')
    assert.equal(result.timedOut, true)
  })
})

describe('sandbox evaluation', () => {
  it('defines the required 12 cases', () => {
    assert.equal(SANDBOX_EVAL_CASES.length, 12)
    assert.deepEqual(SANDBOX_EVAL_CASES.map(item => item.id), [
      'basic-command',
      'workspace-read-write',
      'readonly-rootfs',
      'network-disabled',
      'secret-not-forwarded',
      'host-path-not-mounted',
      'timeout-cleanup',
      'output-truncation',
      'workspace-path-escape',
      'docker-unavailable-no-fallback',
      'non-root-and-capabilities',
      'container-cleanup-on-error',
    ])
  })

  it('runs static and mock sandbox evaluation without Docker', async () => {
    const outputDir = await tempDir()
    const summary = await runSandboxEvaluation({ outputDir, all: true })
    assert.equal(summary.results.length, 12)
    assert.equal(summary.results.every(result => result.status === 'passed'), true)
    assert.ok(summary.badcase?.generated)
  })
})

function dockerResult(exitCode: number, stdout = '', stderr = '') {
  return {
    exitCode,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  }
}
