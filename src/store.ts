// CompressionStore — in-memory TTL+LRU store for reversible projection.
// Stores the original content keyed by SHA-256[:24] hash; hands the model a
// compact marker with flowctx_retrieve(hash=...) for reversibility.
// Ported from flowctx (SQLite layer omitted; DSH session persistence handles durability).

import { createHash } from 'node:crypto'

export interface StoredEntry {
  hash: string
  original: string
  storedAtMs: number
  ttlMs: number
  meta?: Record<string, unknown>
}

export class CompressionStore {
  private map = new Map<string, StoredEntry>()
  private order: string[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries
  }

  static hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 24)
  }

  store(original: string, ttlSeconds: number, meta?: Record<string, unknown>): string {
    const hash = CompressionStore.hash(original)
    const nowMs = Date.now()
    const ttlMs = ttlSeconds * 1000
    if (!this.map.has(hash)) this.order.push(hash)
    this.map.set(hash, { hash, original, storedAtMs: nowMs, ttlMs, meta })
    this.evictIfNeeded()
    return hash
  }

  retrieve(hash: string): string | null {
    const e = this.map.get(hash)
    if (!e) return null
    if (e.ttlMs > 0 && Date.now() - e.storedAtMs > e.ttlMs) {
      this.map.delete(hash)
      return null
    }
    return e.original
  }

  private evictIfNeeded(): void {
    const nowMs = Date.now()
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift()
      if (oldest) this.map.delete(oldest)
    }
    for (const [hash, e] of this.map) {
      if (e.ttlMs > 0 && nowMs - e.storedAtMs > e.ttlMs) this.map.delete(hash)
    }
  }

  get size(): number {
    return this.map.size
  }
}

export function buildMarker(params: {
  hash: string
  originalChars: number
  keptChars: number
  ttlSeconds: number
  kind: string
}): string {
  const mins = Math.round(params.ttlSeconds / 60)
  return (
    `[flowctx-dsh: ${params.kind} compressed ${params.originalChars}→${params.keptChars} chars. ` +
    `Retrieve original via flowctx_retrieve(hash="${params.hash}"). Expires in ~${mins}m.]`
  )
}
