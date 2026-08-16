import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { HANDOFF_INSTRUCTION } from './prompt.ts'
import { type FlowCtxDshConfig, resolveConfig, type ResolvedFlowCtxConfig } from './config.ts'
import { CompressionStore } from './store.ts'
import { Scratchpad } from './scratchpad.ts'
import { projectBlock } from './projection.ts'
import { estimateTokens } from './tokens.ts'
import {
  type SummaryNode,
  planSummaryJobs,
  activeSummaryNodes,
  nodeId,
  buildLayeredPlaceholderText,
} from './summary-tree.ts'

type SummarizeInput = Parameters<BasicCompactionEngine['summarize']>[0]
type SummarizeAgent = Parameters<BasicCompactionEngine['summarize']>[1]

interface SessionMeta {
  summaryNodes: SummaryNode[]
  leafCursorMsg: number
  leafCursorTurn: number
  summaryGen: number
  summaryAbort?: AbortController
  summaryInFlightNodes: Set<string>
}

/**
 * Context compression engine for DSH.
 *
 * Extends BasicCompactionEngine with:
 *   1. Engineer handoff-note summarization style (override summarize())
 *   2. Multi-layer DAG compaction (layered leaf+condense drain loop)
 *   3. Reversible tool-result projection (tools/post-execute hook)
 *   4. Working-memory scratchpad tools (flowctx_scratch_*)
 *   5. flowctx_retrieve tool for hash/node lookups
 */
export class FlowCtxCompactionEngine extends BasicCompactionEngine {
  private readonly _fcfg: ResolvedFlowCtxConfig
  private readonly _store: CompressionStore
  private readonly _scratch: Scratchpad
  private readonly _sessionMeta = new Map<string, SessionMeta>()

  constructor(
    ctx: ConstructorParameters<typeof BasicCompactionEngine>[0],
    pluginConfig: FlowCtxDshConfig = {},
  ) {
    const cfg = resolveConfig(pluginConfig)
    const { summaryMaxTokens: _sm, layeredSummary: _ls, leafChunkTokens: _lc,
      condenseFanout: _cf, maxSummaryDepth: _md, summaryKeepRecentTurns: _sk,
      freshTailWindow: _fw, projection: _pr, projectionThreshold: _pt,
      projectionTtlSeconds: _ps, scratchpad: _sc, scratchpadMaxChars: _smc,
      ...baseConfig } = pluginConfig
    super(ctx, baseConfig)
    this._fcfg = cfg
    this._store = new CompressionStore()
    this._scratch = new Scratchpad(cfg.scratchpadMaxChars)
    this._registerProjection()
    this._registerTools()
    if (cfg.layeredSummary) this._registerLayeredCompaction()
  }

  // ---- Summarize override: engineer handoff-note prompt ----

  override async summarize(
    input: SummarizeInput,
    agent: SummarizeAgent,
    signal?: AbortSignal,
  ): ReturnType<BasicCompactionEngine['summarize']> {
    const target = resolveTarget(agent, this.config)
    if (!target) {
      throw new Error(
        'flowctx-dsh: no provider/model available for summarization — ' +
        'set summarizationProvider+summarizationModel in config, route one request first, ' +
        'or set both AgentOptions provider+model fields',
      )
    }

    const maxTokens = this._fcfg.summaryMaxTokens ?? this.config.maxTokens

    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'flowctx-dsh' },
      }),
    ]

    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal !== undefined ? { signal } : {}),
    })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const err = new Error(finish.failure.message)
      ;(err as NodeJS.ErrnoException).code = finish.failure.code
      throw err
    }
    if (finish.kind === 'max-tokens') {
      throw new Error('flowctx-dsh: summarization truncated at token cap (incomplete handoff note)')
    }

    const rawOutput = assembler.blocks()
    if (contentHasImage(rawOutput)) {
      throw new LlmError('flowctx-dsh: compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
    }
    const summary = rawOutput.filter((b) => b.type === 'text')
    if (!summary.some((b) => b.text.trim().length > 0)) {
      throw new Error('flowctx-dsh: summarization produced no text content')
    }

    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(assembler.usage !== undefined ? { usage: assembler.usage } : {}),
    }
  }

  // ---- Layered DAG drain via agent/pre-step ----

  private _getOrCreateMeta(sessionId: string): SessionMeta {
    let meta = this._sessionMeta.get(sessionId)
    if (!meta) {
      meta = { summaryNodes: [], leafCursorMsg: 0, leafCursorTurn: 0, summaryGen: 0, summaryInFlightNodes: new Set() }
      this._sessionMeta.set(sessionId, meta)
    }
    return meta
  }

  /** Extract surface messages from session events in surface order. */
  private _surfaceMessages(agent: SummarizeAgent): Message[] {
    const session = agent.session
    const seqs = session.surface.nodes
    const events = session.events
    const messages: Message[] = []
    for (const seq of seqs) {
      const event = events[seq]
      if (event === undefined) continue
      const msg = session.deriveEventMessage(event)
      if (msg !== null) messages.push(msg)
    }
    return messages
  }

  private _registerLayeredCompaction(): void {
    const { ctx } = this

    ctx.on('agent/pre-step', async (
      { agent, signal }: { agent: Agent; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision

      const sessionId = agent.session.id
      const meta = this._getOrCreateMeta(sessionId)
      const messages = this._surfaceMessages(agent)
      const frozenStart = Math.max(0, messages.length - this._fcfg.freshTailWindow)

      const plan = planSummaryJobs(messages, frozenStart, meta.summaryNodes, meta.leafCursorMsg, {
        leafChunkTokens: this._fcfg.leafChunkTokens,
        condenseFanout: this._fcfg.condenseFanout,
        maxSummaryDepth: this._fcfg.maxSummaryDepth,
        summaryKeepRecentTurns: this._fcfg.summaryKeepRecentTurns,
      })

      const leafId = plan.leaf ? nodeId(0, plan.leaf.startTurn, plan.leaf.endTurn) : undefined
      if (plan.leaf || plan.condense) {
        if (!leafId || !plan.condense && meta.summaryInFlightNodes.has(leafId)) {
          // skip: already in flight
        } else {
          meta.summaryAbort?.abort()
          const gen = meta.summaryGen + 1
          meta.summaryGen = gen
          const abort = new AbortController()
          meta.summaryAbort = abort
          void this._runLayeredDrain(sessionId, agent, messages, frozenStart, gen, abort.signal)
        }
      }

      // Inject active summary node placeholders into the entering messages.
      const active = activeSummaryNodes(meta.summaryNodes)
      if (!active.length) return decision
      const placeholders: UserMessage[] = active.map((node) =>
        createUserMessage({
          content: [{ type: 'text', text: buildLayeredPlaceholderText(node) }],
          source: { kind: 'plugin', plugin: 'flowctx-dsh' },
        }),
      )
      return { kind: 'enter', messages: [...placeholders, ...decision.messages] }
    })
  }

  private async _runLayeredDrain(
    sessionId: string,
    agent: SummarizeAgent,
    messages: Message[],
    frozenStart: number,
    gen: number,
    signal: AbortSignal,
  ): Promise<void> {
    let foldedLeaves = 0

    for (;;) {
      if (signal.aborted) break
      const meta = this._sessionMeta.get(sessionId)
      if (!meta || meta.summaryGen !== gen) break

      const plan = planSummaryJobs(messages, frozenStart, meta.summaryNodes, meta.leafCursorMsg, {
        leafChunkTokens: this._fcfg.leafChunkTokens,
        condenseFanout: this._fcfg.condenseFanout,
        maxSummaryDepth: this._fcfg.maxSummaryDepth,
        summaryKeepRecentTurns: this._fcfg.summaryKeepRecentTurns,
      })
      if (!plan.leaf) break

      const outcome = await this._runLeafJob(sessionId, agent, messages, plan.leaf, gen, signal)
      if (outcome === 'aborted') return
      if (outcome === 'in_flight') break
      if (outcome === 'committed') foldedLeaves++
    }

    if (!signal.aborted) {
      const meta = this._sessionMeta.get(sessionId)
      if (meta && meta.summaryGen === gen) {
        const plan = planSummaryJobs(messages, frozenStart, meta.summaryNodes, meta.leafCursorMsg, {
          leafChunkTokens: this._fcfg.leafChunkTokens,
          condenseFanout: this._fcfg.condenseFanout,
          maxSummaryDepth: this._fcfg.maxSummaryDepth,
          summaryKeepRecentTurns: this._fcfg.summaryKeepRecentTurns,
        })
        if (plan.condense) {
          await this._runCondenseJob(sessionId, agent, plan.condense, gen, signal)
        }
      }
    }

    const meta = this._sessionMeta.get(sessionId)
    if (meta && meta.summaryGen === gen) meta.summaryAbort = undefined
    this.ctx.logger.info(`flowctx-dsh layered drain complete: session=${sessionId} leaves=${foldedLeaves}`)
  }

  private async _runLeafJob(
    sessionId: string,
    agent: SummarizeAgent,
    messages: Message[],
    leaf: NonNullable<ReturnType<typeof planSummaryJobs>['leaf']>,
    gen: number,
    signal: AbortSignal,
  ): Promise<'committed' | 'skipped' | 'in_flight' | 'aborted'> {
    const meta = this._sessionMeta.get(sessionId)
    if (!meta) return 'aborted'

    const id = nodeId(0, leaf.startTurn, leaf.endTurn)
    if (meta.summaryInFlightNodes.has(id)) return 'in_flight'
    meta.summaryInFlightNodes.add(id)

    const slice = messages.slice(leaf.startMsg, leaf.endMsg)
    let summaryText: string | null = null
    let usedModel: string | undefined

    try {
      const target = resolveTarget(agent, this.config)
      if (!target) throw new Error('no model target')
      const maxTokens = this._fcfg.summaryMaxTokens ?? this.config.maxTokens

      // Build pseudo-messages for the slice: flatten to text blocks + instruction.
      const callMessages: UserMessage[] = [
        ...slice.map((m) => {
          const textBlocks = m.content.filter((b) => b.type === 'text')
          return createUserMessage({
            content: textBlocks.length > 0
              ? textBlocks
              : [{ type: 'text' as const, text: `[${m.role} message]` }],
            source: { kind: 'plugin' as const, plugin: 'flowctx-dsh' },
          })
        }),
        createUserMessage({
          content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
          source: { kind: 'plugin', plugin: 'flowctx-dsh' },
        }),
      ]

      const assembler = new BlockAssembler()
      for await (const chunk of this.ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        messages: callMessages,
        maxTokens,
        sessionId: agent.session.id,
        purpose: 'compaction',
        signal,
      })) {
        assembler.push(chunk)
      }

      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
      if (finish.kind === 'max-tokens') throw new Error('truncated at token cap')

      const blocks = assembler.blocks()
      const textContent = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      if (textContent) { summaryText = textContent; usedModel = target.model }
    } catch {
      summaryText = null
    }

    const currentMeta = this._sessionMeta.get(sessionId)
    currentMeta?.summaryInFlightNodes.delete(id)
    if (!currentMeta || currentMeta.summaryGen !== gen || signal.aborted) return 'aborted'

    currentMeta.leafCursorMsg = leaf.endMsg
    currentMeta.leafCursorTurn = leaf.endTurn

    if (summaryText && this._looksLikeHandoffNote(summaryText)) {
      const node: SummaryNode = {
        id, depth: 0,
        coverStartTurn: leaf.startTurn, coverEndTurn: leaf.endTurn, coverEndMsgCount: leaf.endMsg,
        content: summaryText, estTokens: estimateTokens(summaryText), createdAtMs: Date.now(),
        ...(usedModel ? { model: usedModel } : {}),
      }
      currentMeta.summaryNodes = [...currentMeta.summaryNodes.filter((n) => n.id !== id), node]
        .sort((a, b) => a.coverStartTurn - b.coverStartTurn)
      return 'committed'
    }
    return 'skipped'
  }

  private async _runCondenseJob(
    sessionId: string,
    agent: SummarizeAgent,
    condense: NonNullable<ReturnType<typeof planSummaryJobs>['condense']>,
    gen: number,
    signal: AbortSignal,
  ): Promise<'committed' | 'skipped' | 'aborted'> {
    const meta = this._sessionMeta.get(sessionId)
    if (!meta) return 'aborted'

    const id = nodeId(condense.depth, condense.startTurn, condense.endTurn)
    if (meta.summaryInFlightNodes.has(id)) return 'skipped'
    meta.summaryInFlightNodes.add(id)

    let summaryText: string | null = null
    let usedModel: string | undefined

    try {
      const target = resolveTarget(agent, this.config)
      if (!target) throw new Error('no model target')
      const maxTokens = this._fcfg.summaryMaxTokens ?? this.config.maxTokens

      const callMessages: UserMessage[] = [
        ...condense.childContents.map((c) =>
          createUserMessage({
            content: [{ type: 'text', text: c }],
            source: { kind: 'plugin' as const, plugin: 'flowctx-dsh' },
          }),
        ),
        createUserMessage({
          content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
          source: { kind: 'plugin', plugin: 'flowctx-dsh' },
        }),
      ]

      const assembler = new BlockAssembler()
      for await (const chunk of this.ctx.llm.stream({
        provider: target.provider, model: target.model,
        messages: callMessages, maxTokens,
        sessionId: agent.session.id, purpose: 'compaction', signal,
      })) assembler.push(chunk)

      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
      const blocks = assembler.blocks()
      const textContent = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      if (textContent) { summaryText = textContent; usedModel = target.model }
    } catch { summaryText = null }

    const currentMeta = this._sessionMeta.get(sessionId)
    currentMeta?.summaryInFlightNodes.delete(id)
    if (!currentMeta || currentMeta.summaryGen !== gen || signal.aborted) return 'aborted'

    if (summaryText && this._looksLikeHandoffNote(summaryText)) {
      const node: SummaryNode = {
        id, depth: condense.depth,
        coverStartTurn: condense.startTurn, coverEndTurn: condense.endTurn, coverEndMsgCount: 0,
        content: summaryText, childIds: condense.childIds,
        estTokens: estimateTokens(summaryText), createdAtMs: Date.now(),
        ...(usedModel ? { model: usedModel } : {}),
      }
      currentMeta.summaryNodes = [...currentMeta.summaryNodes.filter((n) => n.id !== id), node]
        .sort((a, b) => a.coverStartTurn - b.coverStartTurn)
      return 'committed'
    }
    return 'skipped'
  }

  private _looksLikeHandoffNote(text: string): boolean {
    return text.includes('## TASK') || text.includes('## WORKING') || text.includes('## OPEN STATE')
  }

  // ---- Tool-result projection (tools/post-execute) ----

  private _registerProjection(): void {
    if (!this._fcfg.projection) return

    const store = this._store
    const threshold = this._fcfg.projectionThreshold
    const ttl = this._fcfg.projectionTtlSeconds

    this.ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decision = await next()
      if (decision.kind !== 'accept') return decision

      const content = result.content
      if (!content.length) return decision

      let changed = false
      const newBlocks = content.map((block) => {
        if (block.type !== 'text') return block
        const projected = projectBlock(block.text, store, {
          thresholdTokens: threshold,
          ttlSeconds: ttl,
          kind: 'tool-result',
          toolName: exec.name,
        })
        if (projected.compressed) { changed = true; return { type: 'text' as const, text: projected.text } }
        return block
      })
      if (!changed) return decision
      return { kind: 'accept', content: newBlocks }
    })
  }

  // ---- Tool registration ----

  private _registerTools(): void {
    const { ctx } = this
    const store = this._store
    const scratch = this._scratch
    const sessionMeta = this._sessionMeta

    ctx.tools.register(defineTool({
      name: 'flowctx_retrieve',
      description:
        'Retrieve the full original content behind a flowctx-dsh marker. ' +
        'Pass `hash` (24-char hash from a [flowctx-dsh: ... flowctx_retrieve(hash="...")] marker) ' +
        'to get the verbatim compressed-away text; OR pass `node` (e.g. "d0-1-12" from a ' +
        '<flowctx-history-summary> block) to get that summary layer\'s full note.',
      parameters: {
        hash: { type: 'string', description: 'The 24-char hash from a flowctx-dsh compression marker.' },
        node: { type: 'string', description: 'A summary-layer node id (e.g. d0-1-12).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const nodeArg = (args.node ?? '').trim()
        if (nodeArg) {
          for (const meta of sessionMeta.values()) {
            const found = meta.summaryNodes.find((n: SummaryNode) => n.id === nodeArg)
            if (found) return found.content
          }
          return `flowctx_retrieve: no summary node id=${nodeArg}.`
        }
        const hashArg = (args.hash ?? '').trim()
        if (!hashArg) return "flowctx_retrieve: pass either 'hash' or 'node'."
        const original = store.retrieve(hashArg)
        return original ?? `flowctx_retrieve: no entry for hash=${hashArg} (expired or never stored).`
      },
    }))

    if (!this._fcfg.scratchpad) return

    ctx.tools.register(defineTool({
      name: 'flowctx_scratch_append',
      description:
        'Append a line to your working-memory scratchpad (<working_memory> block). ' +
        'Use for current goals, open sub-tasks, or a key result you must not forget this session.',
      parameters: { text: { type: 'string', description: 'Text to append.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const key = exec?.agent?.session?.id ?? 'default'
        const content = scratch.append(key, String(args.text ?? ''))
        return `scratchpad now ${content.length} chars.`
      },
    }))

    ctx.tools.register(defineTool({
      name: 'flowctx_scratch_replace',
      description: 'Replace the first occurrence of old_text with new_text in your working-memory scratchpad.',
      parameters: { old_text: { type: 'string' }, new_text: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const key = exec?.agent?.session?.id ?? 'default'
        const content = scratch.replace(key, String(args.old_text ?? ''), String(args.new_text ?? ''))
        return `scratchpad now ${content.length} chars.`
      },
    }))

    ctx.tools.register(defineTool({
      name: 'flowctx_scratch_rethink',
      description: 'Rewrite the entire working-memory scratchpad from scratch with a cleaner, more concise version.',
      parameters: { content: { type: 'string', description: 'The new full scratchpad content.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const key = exec?.agent?.session?.id ?? 'default'
        const newContent = scratch.rethink(key, String(args.content ?? ''))
        return `scratchpad rewritten, now ${newContent.length} chars.`
      },
    }))
  }
}

/** Resolve the provider/model target in the same order as dsh-compaction-basic. */
export function resolveTarget(
  agent: SummarizeAgent,
  config: { summarizationProvider: string; summarizationModel: string },
): { provider: string; model: string } | undefined {
  if (config.summarizationProvider.length > 0 && config.summarizationModel.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  return undefined
}
