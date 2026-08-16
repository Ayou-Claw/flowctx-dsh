import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CompressionStore, buildMarker } from '../src/store.ts'
import { KvStore } from '../src/db/kv-store.ts'

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

describe('CompressionStore durable SQLite layer', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flowctx-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('retrieves from SQLite after an in-memory miss (restart path)', () => {
    const kv = new KvStore(path.join(dir, 'flowctx.sqlite'))
    // Skip when node:sqlite is unavailable — persistence degrades to no-op there.
    if (!kv.available) return
    const writer = new CompressionStore({ kv })
    const hash = writer.store('durable payload', 3600, {})

    // A fresh store sharing the same handle has an empty in-memory map, so the
    // hit must come from SQLite (the post-restart retrieval path).
    const reader = new CompressionStore({ kv })
    expect(reader.retrieve(hash)).toBe('durable payload')
  })

  it('re-warms the in-memory map on a SQLite hit', () => {
    const kv = new KvStore(path.join(dir, 'flowctx.sqlite'))
    if (!kv.available) return
    const writer = new CompressionStore({ kv })
    const hash = writer.store('rewarm me', 3600, {})

    const reader = new CompressionStore({ kv })
    expect(reader.size).toBe(0)
    reader.retrieve(hash)
    expect(reader.size).toBe(1)
  })

  it('shares one handle across refs and other namespaces without conflict', () => {
    const kv = new KvStore(path.join(dir, 'flowctx.sqlite'))
    if (!kv.available) return
    const store = new CompressionStore({ kv })
    const hash = store.store('ref content', 3600, {})
    // Simulate the engine writing summary nodes through the SAME handle.
    kv.putSync('summary-nodes', 'session-1', JSON.stringify([{ id: 'd0-1-2' }]), null)
    expect(store.retrieve(hash)).toBe('ref content')
    expect(kv.get('summary-nodes', 'session-1')).toContain('d0-1-2')
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
