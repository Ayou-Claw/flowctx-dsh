// Working-memory scratchpad — ported from flowctx.
// Session-scoped, model-editable <working_memory> block.
// Three surgical mutation ops: append / replace / rethink.
//
// Persistence: like the compression-refs and summary-node stores, the
// scratchpad persists through a shared KvStore when a stateDir is configured,
// so working memory survives a process restart. Each session's content is one
// row keyed by session id under a dedicated namespace. Content is lazily
// re-hydrated from SQLite on first touch of a session, then kept hot in memory.

import type { KvStore } from './db/kv-store.ts'

export interface ScratchpadOptions {
  /** Durable KvStore (shared, one handle per DB file). Omit for memory-only. */
  kv?: KvStore
  /** Namespace for scratchpad rows in the shared KvStore. */
  ns?: string
}

const DEFAULT_NS = 'scratchpad'

export class Scratchpad {
  private blocks = new Map<string, string>()
  /** Sessions already hydrated from the durable layer (avoids repeat reads). */
  private hydrated = new Set<string>()
  private readonly maxChars: number
  private readonly kv?: KvStore
  private readonly ns: string

  constructor(maxChars: number, options?: ScratchpadOptions) {
    this.maxChars = maxChars
    if (options?.kv?.available) this.kv = options.kv
    this.ns = options?.ns ?? DEFAULT_NS
  }

  get(sessionKey: string): string {
    // Lazy re-hydration: on first touch, pull any persisted content into memory.
    if (!this.blocks.has(sessionKey) && this.kv && !this.hydrated.has(sessionKey)) {
      this.hydrated.add(sessionKey)
      const persisted = this.kv.get(this.ns, sessionKey)
      if (persisted !== null) this.blocks.set(sessionKey, persisted)
    }
    return this.blocks.get(sessionKey) ?? ''
  }

  append(sessionKey: string, text: string): string {
    const cur = this.get(sessionKey)
    const next = cur ? `${cur}\n${text}` : text
    return this.set(sessionKey, next)
  }

  replace(sessionKey: string, oldText: string, newText: string): string {
    const cur = this.get(sessionKey)
    const next = cur.includes(oldText) ? cur.replace(oldText, newText) : cur
    return this.set(sessionKey, next)
  }

  rethink(sessionKey: string, content: string): string {
    // Touch to ensure hydration flag is set before overwrite (keeps semantics
    // consistent whether or not the session was previously persisted).
    this.get(sessionKey)
    return this.set(sessionKey, content)
  }

  render(sessionKey: string): string | null {
    const content = this.get(sessionKey)
    if (!content) return null
    return (
      `<working_memory chars_current="${content.length}" chars_limit="${this.maxChars}">\n` +
      `${content}\n` +
      `</working_memory>`
    )
  }

  private set(sessionKey: string, raw: string): string {
    const clamped = raw.slice(0, this.maxChars)
    this.blocks.set(sessionKey, clamped)
    this.hydrated.add(sessionKey)
    if (this.kv) {
      // Scratchpad has no natural TTL — it lives as long as the session does.
      // null expiry = never auto-expire (session lifecycle governs cleanup).
      this.kv.putSync(this.ns, sessionKey, clamped, null)
    }
    return clamped
  }
}
