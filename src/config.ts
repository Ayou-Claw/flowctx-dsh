/** Configuration schema for flowctx-dsh. */
export interface FlowCtxDshConfig {
  /**
   * Override provider for summarization calls.
   * Must be set together with summarizationModel, or both left empty.
   */
  summarizationProvider?: string
  /**
   * Override model for summarization calls.
   * Must be set together with summarizationProvider, or both left empty.
   */
  summarizationModel?: string
  /**
   * Max tokens for the summarization call.
   * Defaults to the basic engine's configured maxTokens.
   */
  summaryMaxTokens?: number
  /** Per-model compaction policies forwarded to BasicCompactionEngine. */
  thresholdRatio?: number
  retainRatio?: number
  retainTokens?: number
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
}
