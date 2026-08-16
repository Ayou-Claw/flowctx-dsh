import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { CompressionStore, buildMarker } from '../src/store.ts'

describe('CompressionStore', () => {
  it('stores and retrieves content by hash', () => {
    const store = new CompressionStore()
    const hash = store.store('hello world', 3600, {})
    expect(store.retrieve(hash)).toBe('hello world')
  })

  it('returns null for unknown hash', () => {
    const store = new CompressionStore()
    expect(store.retrieve('000000000000000000000000')).toBeNull()
  })

  it('same content always produces the same hash', () => {
    const store = new CompressionStore()
    const h1 = store.store('abc', 3600, {})
    const h2 = store.store('abc', 3600, {})
    expect(h1).toBe(h2)
  })

  it('different content produces different hashes', () => {
    const store = new CompressionStore()
    const h1 = store.store('content-a', 3600, {})
    const h2 = store.store('content-b', 3600, {})
    expect(h1).not.toBe(h2)
  })

  it('hash is 24 chars', () => {
    const store = new CompressionStore()
    const hash = store.store('test', 3600, {})
    expect(hash).toHaveLength(24)
  })

  it('static hash() matches store() hash', () => {
    const content = 'deterministic content'
    const hash = CompressionStore.hash(content)
    const store = new CompressionStore()
    const stored = store.store(content, 3600, {})
    expect(hash).toBe(stored)
  })

  it('evicts expired entries', () => {
    vi.useFakeTimers()
    const store = new CompressionStore()
    const hash = store.store('expires soon', 1, {}) // 1 second TTL
    expect(store.retrieve(hash)).toBe('expires soon')
    vi.advanceTimersByTime(2000) // 2 seconds later
    expect(store.retrieve(hash)).toBeNull()
    vi.useRealTimers()
  })

  it('respects max entries (FIFO eviction when full)', () => {
    const store = new CompressionStore(3)
    const h1 = store.store('entry-1', 3600, {})
    const h2 = store.store('entry-2', 3600, {})
    store.store('entry-3', 3600, {})
    expect(store.size).toBe(3)
    // Adding a 4th evicts the oldest (h1)
    store.store('entry-4', 3600, {})
    expect(store.size).toBe(3)
    expect(store.retrieve(h1)).toBeNull() // oldest evicted
    expect(store.retrieve(h2)).toBe('entry-2') // still present
  })
})

describe('buildMarker()', () => {
  it('contains the hash', () => {
    const marker = buildMarker({ hash: 'abc123', originalChars: 1000, keptChars: 200, ttlSeconds: 3600, kind: 'tool-result' })
    expect(marker).toContain('abc123')
  })

  it('contains flowctx_retrieve reference', () => {
    const marker = buildMarker({ hash: 'abc123', originalChars: 1000, keptChars: 200, ttlSeconds: 3600, kind: 'block' })
    expect(marker).toContain('flowctx_retrieve')
  })

  it('shows original and kept char counts', () => {
    const marker = buildMarker({ hash: 'abc123', originalChars: 1000, keptChars: 200, ttlSeconds: 3600, kind: 'block' })
    expect(marker).toContain('1000')
    expect(marker).toContain('200')
  })

  it('shows TTL in minutes', () => {
    const marker = buildMarker({ hash: 'abc123', originalChars: 1000, keptChars: 200, ttlSeconds: 3600, kind: 'block' })
    expect(marker).toContain('60m') // 3600s = 60min
  })

  it('is a single line (no newlines)', () => {
    const marker = buildMarker({ hash: 'abc123', originalChars: 100, keptChars: 50, ttlSeconds: 60, kind: 'json' })
    expect(marker).not.toContain('\n')
  })
})
