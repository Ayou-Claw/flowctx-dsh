import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import { HANDOFF_INSTRUCTION } from './prompt.ts'
import type { FlowCtxDshConfig } from './config.ts'

type SummarizeInput = Parameters<BasicCompactionEngine['summarize']>[0]
type SummarizeAgent = Parameters<BasicCompactionEngine['summarize']>[1]

/**
 * Compaction engine that replaces the generic summarization instruction with
 * the structured engineer handoff-note prompt. Everything else — pressure
 * detection, retention budgets, KV-cache replay, and surface replacement —
 * is inherited from BasicCompactionEngine unchanged.
 */
export class FlowCtxCompactionEngine extends BasicCompactionEngine {
  private _summaryMaxTokens: number | undefined

  constructor(
    ctx: ConstructorParameters<typeof BasicCompactionEngine>[0],
    pluginConfig: FlowCtxDshConfig = {},
  ) {
    const { summaryMaxTokens, ...baseConfig } = pluginConfig
    super(ctx, baseConfig as ConstructorParameters<typeof BasicCompactionEngine>[1])
    this._summaryMaxTokens = summaryMaxTokens
  }

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

    const maxTokens = this._summaryMaxTokens ?? this.config.maxTokens

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
