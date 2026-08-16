import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FlowCtxCompactionEngine, resolveTarget } from '../src/engine.ts'
import { HANDOFF_INSTRUCTION } from '../src/prompt.ts'

// ---------------------------------------------------------------------------
// resolveTarget — pure function, no cordis needed
// ---------------------------------------------------------------------------

describe('resolveTarget()', () => {
  function fakeAgent(opts: {
    requestHeaderConfig?: { provider: string; model: string }
    provider?: string
    model?: string
  }) {
    return {
      session: {
        id: 'test',
        requestHeader: () =>
          opts.requestHeaderConfig !== undefined
            ? { config: opts.requestHeaderConfig }
            : undefined,
      },
      options: {
        provider: opts.provider,
        model: opts.model,
      },
    }
  }

  const configuredTarget = { summarizationProvider: 'cfg-p', summarizationModel: 'cfg-m' }
  const emptyConfig = { summarizationProvider: '', summarizationModel: '' }

  it('prefers configured provider/model', () => {
    const agent = fakeAgent({ requestHeaderConfig: { provider: 'hdr-p', model: 'hdr-m' }, provider: 'opt-p', model: 'opt-m' })
    expect(resolveTarget(agent as never, configuredTarget)).toEqual({ provider: 'cfg-p', model: 'cfg-m' })
  })

  it('falls back to requestHeader config', () => {
    const agent = fakeAgent({ requestHeaderConfig: { provider: 'hdr-p', model: 'hdr-m' }, provider: 'opt-p', model: 'opt-m' })
    expect(resolveTarget(agent as never, emptyConfig)).toEqual({ provider: 'hdr-p', model: 'hdr-m' })
  })

  it('falls back to agent.options', () => {
    const agent = fakeAgent({ provider: 'opt-p', model: 'opt-m' })
    expect(resolveTarget(agent as never, emptyConfig)).toEqual({ provider: 'opt-p', model: 'opt-m' })
  })

  it('returns undefined when nothing is set', () => {
    const agent = fakeAgent({})
    expect(resolveTarget(agent as never, emptyConfig)).toBeUndefined()
  })

  it('returns undefined when requestHeader is empty strings', () => {
    const agent = fakeAgent({ requestHeaderConfig: { provider: '', model: '' } })
    expect(resolveTarget(agent as never, emptyConfig)).toBeUndefined()
  })

  it('returns undefined when agent options are empty strings', () => {
    const agent = fakeAgent({ provider: '', model: '' })
    expect(resolveTarget(agent as never, emptyConfig)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FlowCtxCompactionEngine — requires a cordis Context with service stubs
// ---------------------------------------------------------------------------

/** Build a minimal cordis Context with the services BasicCompactionEngine needs. */
function makeCtx() {
  const ctx = new Context()

  // Provide stub services so cordis.provide() succeeds for llm/tokenMeter/sessions/tools
  const streamMock = vi.fn(async function* (_options: unknown) {
    // default: no chunks
  })
  ctx.provide('llm', { stream: streamMock } as never)
  ctx.provide('tokenMeter', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('tools', { register: vi.fn(), execute: vi.fn() } as never)

  return { ctx, streamMock }
}

function makeAgent(opts: {
  requestHeaderConfig?: { provider: string; model: string }
  provider?: string
  model?: string
} = {}) {
  return {
    session: {
      id: 'test-session',
      requestHeader: vi.fn(() =>
        opts.requestHeaderConfig !== undefined
          ? { config: opts.requestHeaderConfig, system: undefined, tools: undefined }
          : undefined,
      ),
    },
    options: {
      provider: opts.provider,
      model: opts.model,
    },
  }
}

const DUMMY_INPUT = {
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  system: undefined,
  tools: undefined,
}

describe('FlowCtxCompactionEngine', () => {
  it('constructs without error when ctx has required services', () => {
    const { ctx } = makeCtx()
    expect(() => new FlowCtxCompactionEngine(ctx, { auto: false })).not.toThrow()
  })

  it('summarize() throws when no provider/model can be resolved', async () => {
    const { ctx } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, { auto: false })
    const agent = makeAgent()
    await expect(engine.summarize(DUMMY_INPUT as never, agent as never))
      .rejects.toThrow('flowctx-dsh: no provider/model available for summarization')
  })

  it('summarize() calls ctx.llm.stream with resolved provider/model', async () => {
    const { ctx, streamMock } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: 'deepseek',
      summarizationModel: 'deepseek-chat',
    })
    const agent = makeAgent()

    // streamMock yields a text block to satisfy the non-empty-summary check
    streamMock.mockImplementationOnce(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## TASK / GOAL\n- test' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## TASK / GOAL\n- test' } }
      yield { type: 'finish', reason: 'end-turn', replayState: undefined }
    })

    await engine.summarize(DUMMY_INPUT as never, agent as never)

    expect(streamMock).toHaveBeenCalledOnce()
    expect(streamMock.mock.calls[0][0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: 'test-session',
      purpose: 'compaction',
    })
  })

  it('summarize() appends HANDOFF_INSTRUCTION as the last user message', async () => {
    const { ctx, streamMock } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: 'deepseek',
      summarizationModel: 'deepseek-chat',
    })
    const agent = makeAgent()

    streamMock.mockImplementationOnce(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## TASK / GOAL\n- test' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## TASK / GOAL\n- test' } }
      yield { type: 'finish', reason: 'end-turn', replayState: undefined }
    })

    await engine.summarize(DUMMY_INPUT as never, agent as never)

    const { messages } = streamMock.mock.calls[0][0] as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }
    const lastMsg = messages.at(-1)!
    expect(lastMsg.role).toBe('user')
    const textBlock = lastMsg.content.find((b) => b.type === 'text')
    expect(textBlock?.text).toContain('ENGINEER HANDOFF NOTE')
    expect(textBlock?.text).toContain(HANDOFF_INSTRUCTION.slice(0, 40))
  })

  it('summarize() uses summaryMaxTokens when provided', async () => {
    const { ctx, streamMock } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: 'deepseek',
      summarizationModel: 'deepseek-chat',
      summaryMaxTokens: 4096,
    })
    const agent = makeAgent()

    streamMock.mockImplementationOnce(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## TASK / GOAL\n- test' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## TASK / GOAL\n- test' } }
      yield { type: 'finish', reason: 'end-turn', replayState: undefined }
    })

    await engine.summarize(DUMMY_INPUT as never, agent as never)

    expect(streamMock.mock.calls[0][0]).toMatchObject({ maxTokens: 4096 })
  })

  it('summarize() result has llmStreamCall: true', async () => {
    const { ctx, streamMock } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: 'deepseek',
      summarizationModel: 'deepseek-chat',
    })
    const agent = makeAgent()

    streamMock.mockImplementationOnce(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## TASK / GOAL\n- test' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## TASK / GOAL\n- test' } }
      yield { type: 'finish', reason: 'end-turn', replayState: undefined }
    })

    const result = await engine.summarize(DUMMY_INPUT as never, agent as never)

    expect(result.llmStreamCall).toBe(true)
    expect(result.provider).toBe('deepseek')
    expect(result.model).toBe('deepseek-chat')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('summarize() uses session requestHeader when no configured override', async () => {
    const { ctx, streamMock } = makeCtx()
    const engine = new FlowCtxCompactionEngine(ctx, { auto: false })
    const agent = makeAgent({ requestHeaderConfig: { provider: 'anthropic', model: 'claude-opus-5' } })

    streamMock.mockImplementationOnce(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## TASK / GOAL\n- test' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## TASK / GOAL\n- test' } }
      yield { type: 'finish', reason: 'end-turn', replayState: undefined }
    })

    const result = await engine.summarize(DUMMY_INPUT as never, agent as never)

    expect(streamMock.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5',
    })
    expect(result.provider).toBe('anthropic')
  })
})
