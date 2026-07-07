import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgentTurn } from '../src/agent-loop.js'
import type { AgentLoopTraceEvent } from '../src/debug/harness-trace.js'
import { ToolRegistry, type ToolDefinition } from '../src/tool.js'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'

function fixtureTool(ok: boolean): ToolDefinition<{ value?: string }> {
  return {
    name: 'fixture_tool',
    description: 'Test fixture tool.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    schema: z.object({ value: z.string().optional() }),
    async run() {
      return ok
        ? { ok: true, output: 'fixture output' }
        : { ok: false, output: 'fixture failure' }
    },
  }
}

function toolThenAssistantModel(): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      if (messages.some(message => message.role === 'tool_result')) {
        return { type: 'assistant', content: 'final answer' }
      }
      return {
        type: 'tool_calls',
        calls: [{
          id: 'fixture-call',
          toolName: 'fixture_tool',
          input: { value: 'x' },
        }],
      }
    },
  }
}

describe('agent loop observer', () => {
  it('keeps behavior unchanged when no observer is provided', async () => {
    const messages = await runAgentTurn({
      model: { async next() { return { type: 'assistant', content: 'ok' } } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'hello' }],
      cwd: process.cwd(),
      maxSteps: 2,
    })

    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.content : '', 'ok')
  })

  it('emits key events for a successful tool flow in order', async () => {
    const events: AgentLoopTraceEvent[] = []
    const messages = await runAgentTurn({
      model: toolThenAssistantModel(),
      tools: new ToolRegistry([fixtureTool(true)]),
      messages: [{ role: 'user', content: 'use tool' }],
      cwd: process.cwd(),
      maxSteps: 4,
      modelName: 'deepseek-chat',
      observer: {
        onEvent(event) {
          events.push(event)
        },
      },
    })

    const eventTypes = events.map(event => event.event_type)
    assert.ok(eventTypes.indexOf('model_request') < eventTypes.indexOf('model_response'))
    assert.ok(eventTypes.indexOf('tool_call_started') < eventTypes.indexOf('tool_call_completed'))
    assert.ok(eventTypes.includes('messages_updated'))
    assert.equal(events.find(event => event.event_type === 'permission_decision')?.decision, 'not_required')
    assert.equal(messages.map(message => message.role).join(' -> '), 'user -> assistant_tool_call -> tool_result -> assistant')
  })

  it('emits tool failure events and still lets the model produce a final answer', async () => {
    const events: AgentLoopTraceEvent[] = []
    const messages = await runAgentTurn({
      model: toolThenAssistantModel(),
      tools: new ToolRegistry([fixtureTool(false)]),
      messages: [{ role: 'user', content: 'use failing tool' }],
      cwd: process.cwd(),
      maxSteps: 4,
      observer: {
        onEvent(event) {
          events.push(event)
        },
      },
    })

    assert.ok(events.some(event => event.event_type === 'tool_call_failed'))
    assert.equal(messages.at(-1)?.role, 'assistant')
  })

  it('swallows observer errors', async () => {
    const messages = await runAgentTurn({
      model: { async next() { return { type: 'assistant', content: 'survived' } } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'hello' }],
      cwd: process.cwd(),
      observer: {
        onEvent() {
          throw new Error('observer failed')
        },
      },
    })

    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.content : '', 'survived')
  })
})
