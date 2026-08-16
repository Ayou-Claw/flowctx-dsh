import { describe, it, expect } from 'vitest'
import { resolveConfig, CONFIG_DEFAULTS } from '../src/config.ts'

describe('resolveConfig()', () => {
  it('empty input returns all defaults', () => {
    const cfg = resolveConfig({})
    expect(cfg.layeredSummary).toBe(CONFIG_DEFAULTS.layeredSummary)
    expect(cfg.leafChunkTokens).toBe(CONFIG_DEFAULTS.leafChunkTokens)
    expect(cfg.condenseFanout).toBe(CONFIG_DEFAULTS.condenseFanout)
    expect(cfg.maxSummaryDepth).toBe(CONFIG_DEFAULTS.maxSummaryDepth)
    expect(cfg.summaryKeepRecentTurns).toBe(CONFIG_DEFAULTS.summaryKeepRecentTurns)
    expect(cfg.freshTailWindow).toBe(CONFIG_DEFAULTS.freshTailWindow)
    expect(cfg.projection).toBe(CONFIG_DEFAULTS.projection)
    expect(cfg.projectionThreshold).toBe(CONFIG_DEFAULTS.projectionThreshold)
    expect(cfg.projectionTtlSeconds).toBe(CONFIG_DEFAULTS.projectionTtlSeconds)
    expect(cfg.scratchpad).toBe(CONFIG_DEFAULTS.scratchpad)
    expect(cfg.scratchpadMaxChars).toBe(CONFIG_DEFAULTS.scratchpadMaxChars)
  })

  it('boolean fields override correctly', () => {
    const cfg = resolveConfig({ layeredSummary: false, projection: false, scratchpad: true })
    expect(cfg.layeredSummary).toBe(false)
    expect(cfg.projection).toBe(false)
    expect(cfg.scratchpad).toBe(true)
  })

  it('numeric fields override correctly', () => {
    const cfg = resolveConfig({
      leafChunkTokens: 20000,
      condenseFanout: 4,
      maxSummaryDepth: 2,
      summaryKeepRecentTurns: 5,
      freshTailWindow: 32,
      projectionThreshold: 500,
      scratchpadMaxChars: 4000,
    })
    expect(cfg.leafChunkTokens).toBe(20000)
    expect(cfg.condenseFanout).toBe(4)
    expect(cfg.maxSummaryDepth).toBe(2)
    expect(cfg.summaryKeepRecentTurns).toBe(5)
    expect(cfg.freshTailWindow).toBe(32)
    expect(cfg.projectionThreshold).toBe(500)
    expect(cfg.scratchpadMaxChars).toBe(4000)
  })

  it('clamps leafChunkTokens to valid range', () => {
    expect(resolveConfig({ leafChunkTokens: 100 }).leafChunkTokens).toBe(2000)  // min=2000
    expect(resolveConfig({ leafChunkTokens: 999999 }).leafChunkTokens).toBe(64000) // max=64000
  })

  it('clamps condenseFanout to valid range', () => {
    expect(resolveConfig({ condenseFanout: 1 }).condenseFanout).toBe(2)  // min=2
    expect(resolveConfig({ condenseFanout: 100 }).condenseFanout).toBe(32) // max=32
  })

  it('clamps maxSummaryDepth to valid range', () => {
    expect(resolveConfig({ maxSummaryDepth: -1 }).maxSummaryDepth).toBe(0) // min=0
    expect(resolveConfig({ maxSummaryDepth: 99 }).maxSummaryDepth).toBe(3) // max=3
  })

  it('string fields override correctly', () => {
    const cfg = resolveConfig({ summarizationProvider: 'my-provider', summarizationModel: 'my-model' })
    expect(cfg.summarizationProvider).toBe('my-provider')
    expect(cfg.summarizationModel).toBe('my-model')
  })

  it('summaryMaxTokens is undefined by default', () => {
    expect(resolveConfig({}).summaryMaxTokens).toBeUndefined()
  })

  it('summaryMaxTokens passes through when set', () => {
    expect(resolveConfig({ summaryMaxTokens: 8192 }).summaryMaxTokens).toBe(8192)
  })

  it('non-numeric values for numeric fields fall back to defaults', () => {
    // @ts-expect-error intentionally passing wrong type
    const cfg = resolveConfig({ leafChunkTokens: 'not-a-number' })
    expect(cfg.leafChunkTokens).toBe(CONFIG_DEFAULTS.leafChunkTokens)
  })
})
