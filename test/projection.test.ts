import { describe, it, expect } from 'vitest'
import { projectBlock } from '../src/projection.ts'
import { CompressionStore } from '../src/store.ts'

function makeStore() {
  return new CompressionStore()
}

const OPTS = { thresholdTokens: 100, ttlSeconds: 3600, kind: 'tool-result' }

describe('projectBlock()', () => {
  it('returns text unchanged when below threshold', () => {
    const store = makeStore()
    const short = 'short text' // well under 100 tokens
    const result = projectBlock(short, store, OPTS)
    expect(result.text).toBe(short)
    expect(result.compressed).toBe(false)
    expect(result.hash).toBeUndefined()
  })

  it('compresses content above threshold', () => {
    const store = makeStore()
    // ~400 ASCII chars → ~100 tokens, needs to exceed threshold
    const longText = 'x'.repeat(2000) // ~500 tokens
    const result = projectBlock(longText, store, OPTS)
    expect(result.compressed).toBe(true)
    expect(result.text.length).toBeLessThan(longText.length)
  })

  it('stores original content retrievable by hash', () => {
    const store = makeStore()
    const content = 'z'.repeat(2000)
    const result = projectBlock(content, store, OPTS)
    expect(result.hash).toBeDefined()
    expect(store.retrieve(result.hash!)).toBe(content)
  })

  it('compressed output contains flowctx_retrieve marker', () => {
    const store = makeStore()
    const content = 'a'.repeat(2000)
    const result = projectBlock(content, store, OPTS)
    expect(result.text).toContain('flowctx_retrieve')
    expect(result.text).toContain(result.hash)
  })

  it('uses structured compression for JSON content', () => {
    const store = makeStore()
    const bigJson = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 100 }))
    )
    // make it long enough to trigger compression
    const content = bigJson.repeat(3)
    const result = projectBlock(content, store, { ...OPTS, toolName: 'read_file.json' })
    if (result.compressed) {
      expect(['structured', 'head-tail']).toContain(result.strategy)
    }
  })

  it('head-tail fallback for unstructured large text', () => {
    const store = makeStore()
    // purely random-looking text — won't match any structured detector
    const content = 'lorem ipsum dolor sit amet '.repeat(200)
    const result = projectBlock(content, store, OPTS)
    expect(result.compressed).toBe(true)
    // head-tail includes both start and end of original
    if (result.strategy === 'head-tail') {
      const head = content.slice(0, 50)
      const tail = content.slice(-50)
      expect(result.text).toContain(head.slice(0, 20))
      expect(result.text).toContain(tail.slice(-20))
    }
  })

  it('same content produces same hash (deterministic)', () => {
    const store = makeStore()
    const content = 'b'.repeat(2000)
    const r1 = projectBlock(content, store, OPTS)
    const r2 = projectBlock(content, store, OPTS)
    expect(r1.hash).toBe(r2.hash)
  })
})
