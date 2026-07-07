import { copyFile, lstat, mkdir, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SandboxExecutionError } from './errors.js'

export type WorkspaceSnapshotOptions = {
  sourceDirectory: string
  runtimeRoot: string
  runId: string
  maxBytes: number
  maxFiles: number
}

export type WorkspaceSnapshot = {
  runRoot: string
  workspacePath: string
  artifactsPath: string
  metadataPath: string
  fileCount: number
  totalBytes: number
  skipped: string[]
}

const EXCLUDED_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'node_modules',
  '.git',
  '.ssh',
  '.docker',
])

function isSecretLike(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.endsWith('.p12') ||
    lower.endsWith('.pfx') ||
    lower.includes('secret') ||
    lower.includes('token')
  )
}

function assertWithin(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SandboxExecutionError('SECURITY_POLICY_DENIED', `${label} escapes allowed root: ${target}`)
  }
}

export async function createWorkspaceSnapshot(options: WorkspaceSnapshotOptions): Promise<WorkspaceSnapshot> {
  const sourceDirectory = path.resolve(options.sourceDirectory)
  const runtimeRoot = path.resolve(options.runtimeRoot)
  const runRoot = path.join(runtimeRoot, options.runId)
  assertWithin(runtimeRoot, runRoot, 'runRoot')

  const workspacePath = path.join(runRoot, 'workspace')
  const artifactsPath = path.join(runRoot, 'artifacts')
  const metadataPath = path.join(runRoot, 'metadata.json')
  await rm(runRoot, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })
  await mkdir(artifactsPath, { recursive: true })

  const state = {
    fileCount: 0,
    totalBytes: 0,
    skipped: [] as string[],
  }

  await copyTree(sourceDirectory, workspacePath, sourceDirectory, options, state)
  const snapshot: WorkspaceSnapshot = {
    runRoot,
    workspacePath,
    artifactsPath,
    metadataPath,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    skipped: state.skipped,
  }
  await writeFile(metadataPath, `${JSON.stringify({
    run_id: options.runId,
    source_directory: sourceDirectory,
    workspace_path: workspacePath,
    artifacts_path: artifactsPath,
    file_count: state.fileCount,
    total_bytes: state.totalBytes,
    skipped: state.skipped,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  return snapshot
}

async function copyTree(
  source: string,
  destination: string,
  sourceRoot: string,
  options: WorkspaceSnapshotOptions,
  state: { fileCount: number; totalBytes: number; skipped: string[] },
): Promise<void> {
  assertWithin(sourceRoot, source, 'source')
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    const relative = path.relative(sourceRoot, sourcePath)
    if (EXCLUDED_NAMES.has(entry.name) || isSecretLike(entry.name)) {
      state.skipped.push(relative)
      continue
    }

    const info = await lstat(sourcePath)
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath)
      const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget)
      const rel = path.relative(sourceRoot, resolvedTarget)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        state.skipped.push(`${relative} -> ${linkTarget}`)
        continue
      }
      state.skipped.push(`${relative} -> ${linkTarget}`)
      continue
    }

    if (info.isDirectory()) {
      await mkdir(destinationPath, { recursive: true })
      await copyTree(sourcePath, destinationPath, sourceRoot, options, state)
      continue
    }

    if (!info.isFile()) {
      state.skipped.push(relative)
      continue
    }

    state.fileCount += 1
    state.totalBytes += info.size
    if (state.fileCount > options.maxFiles) {
      throw new SandboxExecutionError('WORKSPACE_LIMIT_EXCEEDED', `Snapshot file limit exceeded: ${state.fileCount}`)
    }
    if (state.totalBytes > options.maxBytes) {
      throw new SandboxExecutionError('WORKSPACE_LIMIT_EXCEEDED', `Snapshot byte limit exceeded: ${state.totalBytes}`)
    }
    await copyFile(sourcePath, destinationPath)
  }
}

export async function cleanupSnapshot(runRoot: string, runtimeRoot: string): Promise<void> {
  assertWithin(runtimeRoot, runRoot, 'cleanup target')
  await rm(runRoot, { recursive: true, force: true })
}

export async function snapshotExists(workspacePath: string): Promise<boolean> {
  try {
    const info = await stat(workspacePath)
    return info.isDirectory()
  } catch {
    return false
  }
}
