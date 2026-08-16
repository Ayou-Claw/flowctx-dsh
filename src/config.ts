// Configuration for flowctx-dsh.
// Additive, backward-compatible: every key has a safe default; unknown keys are ignored.
// Inherits all BasicCompactionConfig fields plus flowctx-specific subsystems.

/** Configuration schema for flowctx-dsh. */
export interface FlowCtxDshConfig {
  // ---- summarization model override (forwarded to BasicCompactionEngine) ----
  summarizationProvider?: string
  summarizationModel?: string

  // ---- BasicCompactionConfig fields (forwarded to super()) ----
  thresholdRatio?: number
  retainRatio?: number
  retainTokens?: number
  /** Max tokens for the summarization LLM call. 0 = uncapped (recommended for reasoning models). */
  maxTokens?: number
  compactionRetries?: number
  maxOverflowRetries?: number
  modelPolicies?: Array<{
    provider: string
    model: string
    thresholdRatio?: number
    retainRatio?: number
    retainTokens?: number
    summarizationProvider?: string
    summarizationModel?: string
    maxTokens?: number
    compactionRetries?: number
    maxOverflowRetries?: number
  }>
  auto?: boolean

  // ---- flowctx: summary token cap override ----
  /** Override max tokens specifically for the summary call (defaults to maxTokens). */
  summaryMaxTokens?: number

  // ---- flowctx: layered (DAG) compaction ----
  /**
   * Enable multi-layer leaf+condense DAG compaction instead of single-shot summarize().
   * When true the engine overrides agent/pre-step to drain all foldable chunks per pass.
   * Default: true.
   */
  layeredSummary?: boolean
  /** Raw-message tokens one depth-0 leaf covers. Default: 40000. */
  leafChunkTokens?: number
  /** How many same-depth uncondensed nodes trigger a depth+1 condense. Default: 6. */
  condenseFanout?: number
  /** Max condensation depth (0 = leaves only; 1 = leaf + one condensed layer). Default: 1. */
  maxSummaryDepth?: number
  /** User turns kept verbatim before the summarized prefix. Default: 2. */
  summaryKeepRecentTurns?: number
  /**
   * Messages at the tail of the conversation that are NEVER summarized (raw verbatim).
   * Controls the freshTailWindow / frozenStart boundary. Default: 64.
   */
  freshTailWindow?: number

  // ---- flowctx: reversible tool-result projection ----
  /**
   * Enable reversible structured compression of tool results above the threshold.
   * Default: true.
   */
  projection?: boolean
  /** Token threshold above which a tool result block is compressed. Default: 1000. */
  projectionThreshold?: number
  /** TTL for compressed originals in the in-memory store. Default: 604800 (7 days). */
  projectionTtlSeconds?: number

  // ---- flowctx: working-memory scratchpad ----
  /**
   * Enable the model-editable <working_memory> scratchpad and register the three
   * flowctx_scratch_* tools. Default: false (keeps LLM tool schema lean).
   */
  scratchpad?: boolean
  /** Max chars for the scratchpad block. Default: 8000. */
  scratchpadMaxChars?: number
}

export interface ResolvedFlowCtxConfig {
  summarizationProvider: string
  summarizationModel: string
  thresholdRatio: number | undefined
  retainRatio: number | undefined
  retainTokens: number | undefined
  maxTokens: number | undefined
  compactionRetries: number | undefined
  maxOverflowRetries: number | undefined
  modelPolicies: FlowCtxDshConfig['modelPolicies']
  auto: boolean
  summaryMaxTokens: number | undefined
  layeredSummary: boolean
  leafChunkTokens: number
  condenseFanout: number
  maxSummaryDepth: number
  summaryKeepRecentTurns: number
  freshTailWindow: number
  projection: boolean
  projectionThreshold: number
  projectionTtlSeconds: number
  scratchpad: boolean
  scratchpadMaxChars: number
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

export const CONFIG_DEFAULTS = {
  summarizationProvider: '',
  summarizationModel: '',
  summaryMaxTokens: undefined as number | undefined,
  layeredSummary: true,
  leafChunkTokens: 40000,
  condenseFanout: 6,
  maxSummaryDepth: 1,
  summaryKeepRecentTurns: 2,
  freshTailWindow: 64,
  projection: true,
  projectionThreshold: 1000,
  projectionTtlSeconds: 604800,
  scratchpad: false,
  scratchpadMaxChars: 8000,
} as const

export function resolveConfig(raw: FlowCtxDshConfig): ResolvedFlowCtxConfig {
  const c = raw as Record<string, unknown>
  return {
    summarizationProvider: str(c.summarizationProvider, CONFIG_DEFAULTS.summarizationProvider),
    summarizationModel: str(c.summarizationModel, CONFIG_DEFAULTS.summarizationModel),
    thresholdRatio: typeof c.thresholdRatio === 'number' ? c.thresholdRatio : undefined,
    retainRatio: typeof c.retainRatio === 'number' ? c.retainRatio : undefined,
    retainTokens: typeof c.retainTokens === 'number' ? c.retainTokens : undefined,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : undefined,
    compactionRetries: typeof c.compactionRetries === 'number' ? c.compactionRetries : undefined,
    maxOverflowRetries: typeof c.maxOverflowRetries === 'number' ? c.maxOverflowRetries : undefined,
    modelPolicies: Array.isArray(c.modelPolicies) ? (c.modelPolicies as FlowCtxDshConfig['modelPolicies']) : undefined,
    auto: bool(c.auto, true),
    summaryMaxTokens: typeof c.summaryMaxTokens === 'number' ? c.summaryMaxTokens : undefined,
    layeredSummary: bool(c.layeredSummary, CONFIG_DEFAULTS.layeredSummary),
    leafChunkTokens: num(c.leafChunkTokens, CONFIG_DEFAULTS.leafChunkTokens, 2000, 64000),
    condenseFanout: num(c.condenseFanout, CONFIG_DEFAULTS.condenseFanout, 2, 32),
    maxSummaryDepth: num(c.maxSummaryDepth, CONFIG_DEFAULTS.maxSummaryDepth, 0, 3),
    summaryKeepRecentTurns: num(c.summaryKeepRecentTurns, CONFIG_DEFAULTS.summaryKeepRecentTurns, 0, 100),
    freshTailWindow: num(c.freshTailWindow, CONFIG_DEFAULTS.freshTailWindow, 0, 256),
    projection: bool(c.projection, CONFIG_DEFAULTS.projection),
    projectionThreshold: num(c.projectionThreshold, CONFIG_DEFAULTS.projectionThreshold, 200, 100000),
    projectionTtlSeconds: num(c.projectionTtlSeconds, CONFIG_DEFAULTS.projectionTtlSeconds, 60, 2592000),
    scratchpad: bool(c.scratchpad, CONFIG_DEFAULTS.scratchpad),
    scratchpadMaxChars: num(c.scratchpadMaxChars, CONFIG_DEFAULTS.scratchpadMaxChars, 500, 100000),
  }
}
