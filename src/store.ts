// CompressionStore — reversible projection store.
// In-memory TTL+FIFO map (hot cache) + optional SQLite durable layer.
// The SQLite layer (via KvStore) survives process restarts: retrieve() falls
// back to it on a memory miss, re-warming the in-memory map on hit.

import { createHash } from 'node:crypto'
import { KvStore } from './db/kv-store.ts'

const REFS_NS = 'refs'

export interface StoredEntry {
  hash: string
  original: string
  storedAtMs: number
  ttlMs: number
  meta?: Record<string, unknown>
}

export interface CompressionStoreOptions {
  maxEntries?: number
  /**
   * A durable KvStore for persisting originals (survives restart). Share ONE
   * KvStore per DB file across all consumers — a second DatabaseSync handle on
   * the same file is a concurrency hazard the transaction mutex can't cover
   * (it's per-handle). The engine opens one KvStore and passes it here.
   */
  kv?: KvStore
}

export class CompressionStore {
  private map = new Map<string, StoredEntry>()
  private order: string[] = []
  private readonly maxEntries: number
  private readonly kv?: KvStore

  constructor(options?: CompressionStoreOptions | number) {
    const opts: CompressionStoreOptions =
      typeof options === 'number' ? { maxEntries: options } : (options ?? {})
    this.maxEntries = opts.maxEntries ?? 500
    if (opts.kv?.available) this.kv = opts.kv
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
    if (this.kv) {
      const expiresAtMs = ttlMs <= 0 ? nowMs : nowMs + ttlMs
      this.kv.putSync(REFS_NS, hash, original, expiresAtMs)
    }
    return hash
  }

  retrieve(hash: string): string | null {
    const e = this.map.get(hash)
    if (e) {
      if (e.ttlMs > 0 && Date.now() - e.storedAtMs > e.ttlMs) {
        this.map.delete(hash)
        // fall through to SQLite
      } else {
        return e.original
      }
    }
    // Memory miss → SQLite durable layer (post-restart path).
    if (this.kv) {
      const original = this.kv.get(REFS_NS, hash)
      if (original !== null) {
        if (!this.map.has(hash)) this.order.push(hash)
        this.map.set(hash, { hash, original, storedAtMs: Date.now(), ttlMs: Number.MAX_SAFE_INTEGER })
        this.evictIfNeeded()
        return original
      }
    }
    return null
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
