// Reversible read-time projection — ported from flowctx.
// When a tool result block exceeds projectionThreshold:
//   1. Try structured, content-aware compression (JSON/code/diff/log/search/cli).
//   2. Fall back to content-agnostic head60%+tail30% slice.
// Either way the ORIGINAL is stored in CompressionStore by hash so
// flowctx_retrieve(hash) returns it byte-exact.

import { estimateTokens } from './tokens.ts'
import { CompressionStore, buildMarker } from './store.ts'
import { compressStructured, type ContentType } from './structured.ts'

const HEAD_RATIO = 0.6
const TAIL_RATIO = 0.3

export interface ProjectionResult {
  text: string
  compressed: boolean
  hash?: string
  strategy?: 'structured' | 'head-tail'
  contentType?: ContentType
}

export function projectBlock(
  block: string,
  store: CompressionStore,
  opts: {
    thresholdTokens: number
    ttlSeconds: number
    kind?: string
    toolName?: string
    exitCode?: number
  },
): ProjectionResult {
  if (estimateTokens(block) <= opts.thresholdTokens) {
    return { text: block, compressed: false }
  }

  const hash = store.store(block, opts.ttlSeconds, { kind: opts.kind })

  const structured = compressStructured(block, opts.toolName, opts.exitCode)
  if (structured.text !== null) {
    const marker = buildMarker({
      hash,
      originalChars: block.length,
      keptChars: structured.text.length,
      ttlSeconds: opts.ttlSeconds,
      kind: `${opts.kind ?? 'block'}:${structured.contentType}`,
    })
    return {
      text: `${structured.text}\n\n${marker}`,
      compressed: true,
      hash,
      strategy: 'structured',
      contentType: structured.contentType,
    }
  }

  const keepChars = Math.floor(opts.thresholdTokens * 4)
  const headLen = Math.floor(keepChars * HEAD_RATIO)
  const tailLen = Math.floor(keepChars * TAIL_RATIO)
  const head = block.slice(0, headLen)
  const tail = block.slice(block.length - tailLen)
  const marker = buildMarker({
    hash,
    originalChars: block.length,
    keptChars: head.length + tail.length,
    ttlSeconds: opts.ttlSeconds,
    kind: opts.kind ?? 'block',
  })
  return {
    text: `${head}\n\n${marker}\n\n${tail}`,
    compressed: true,
    hash,
    strategy: 'head-tail',
    contentType: structured.contentType,
  }
}
