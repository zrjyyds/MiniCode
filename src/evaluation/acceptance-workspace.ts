import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function createAcceptanceWorkspace(root: string): Promise<string> {
  const workspace = path.resolve(root)
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(path.join(workspace, 'tests'), { recursive: true })
  await mkdir(path.join(workspace, 'data'), { recursive: true })
  await mkdir(path.join(workspace, 'skills', 'project-verification'), { recursive: true })
  await mkdir(path.join(workspace, 'outputs'), { recursive: true })

  await writeFile(path.join(workspace, 'MINI.md'), [
    '# MiniCode Acceptance Rules',
    '',
    '- After modifying code, you must run tests.',
    '- Reports must be saved under the outputs directory.',
    '- Do not modify files outside this acceptance-workspace.',
    '',
  ].join('\n'), 'utf8')

  await writeFile(path.join(workspace, 'README.md'), [
    '# MiniCode Phase 8 Acceptance Workspace',
    '',
    'This small project verifies real single-agent file reading, editing, test execution, and reporting.',
    '',
  ].join('\n'), 'utf8')

  await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({
    type: 'module',
    scripts: {
      test: 'node --test tests/calculator.test.js',
    },
  }, null, 2)}\n`, 'utf8')

  await writeFile(path.join(workspace, 'data', 'numbers.txt'), '2\n3\n', 'utf8')

  await writeFile(path.join(workspace, 'src', 'calculator.js'), [
    'export function add(a, b) {',
    '  return a - b;',
    '}',
    '',
  ].join('\n'), 'utf8')

  await writeFile(path.join(workspace, 'tests', 'calculator.test.js'), [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { add } from '../src/calculator.js'",
    '',
    "test('add returns the sum of two numbers', () => {",
    '  assert.equal(add(2, 3), 5)',
    '})',
    '',
  ].join('\n'), 'utf8')

  await writeFile(path.join(workspace, 'skills', 'project-verification', 'SKILL.md'), [
    '---',
    'name: project-verification',
    'description: Use for acceptance-workspace verification tasks that require inspecting files, running tests, summarizing changes, and writing a report.',
    '---',
    '',
    '# Project Verification',
    '',
    '1. Inspect the relevant project files.',
    '2. Run the project tests.',
    '3. Summarize the changes made.',
    '4. Write the verification report under the outputs directory.',
    '',
  ].join('\n'), 'utf8')

  return workspace
}
