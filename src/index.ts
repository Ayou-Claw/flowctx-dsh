import type { Context } from '@deepseek-ai/cordis'
import { FlowCtxCompactionEngine } from './engine.ts'
import type { FlowCtxDshConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'flowctx-dsh'

/**
 * Required services. BasicCompactionEngine.inject already lists llm,
 * tokenMeter, and sessions; the compaction service is needed so the
 * engine can register as the active backend.
 */
export const inject = ['llm', 'tokenMeter', 'sessions', 'compaction']

/**
 * Install the FlowCtxCompactionEngine as the active compaction backend.
 * Pressure detection, retention budgets, and surface replacement are
 * inherited from BasicCompactionEngine; only the summarization prompt
 * is overridden to produce an engineer handoff note.
 */
export function apply(ctx: Context, config: FlowCtxDshConfig = {}): void {
  new FlowCtxCompactionEngine(ctx, config)
}
