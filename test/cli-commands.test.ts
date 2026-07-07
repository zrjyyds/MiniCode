import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryHandleLocalCommand } from '../src/cli-commands.ts'
import { MINI_CODE_PERMISSIONS_PATH } from '../src/config.ts'

describe('tryHandleLocalCommand', () => {
  it('shows command executor backend in /status', async () => {
    const previous = process.env.MINI_CODE_COMMAND_EXECUTOR
    process.env.MINI_CODE_COMMAND_EXECUTOR = 'docker'
    try {
      const result = await tryHandleLocalCommand('/status')
      assert.match(result ?? '', /command executor: docker/)
    } finally {
      if (previous === undefined) {
        delete process.env.MINI_CODE_COMMAND_EXECUTOR
      } else {
        process.env.MINI_CODE_COMMAND_EXECUTOR = previous
      }
    }
  })

  it('prints full permission lists for /permissions', async () => {
    const result = await tryHandleLocalCommand('/permissions', {
      permissionSummary: [
        'cwd: /repo',
        'extra allowed dirs: /one, /two',
        'dangerous allowlist: git push, npm publish',
      ],
    })

    assert.equal(
      result,
      [
        `permission store: ${MINI_CODE_PERMISSIONS_PATH}`,
        'cwd: /repo',
        'extra allowed dirs: /one, /two',
        'dangerous allowlist: git push, npm publish',
      ].join('\n'),
    )
  })
})
