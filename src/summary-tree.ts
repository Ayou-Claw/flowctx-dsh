// Multi-layer (layered condensation) summary tree — pure functions + types.
// Ported from flowctx. Zero I/O, zero LLM: testable in isolation.
//
// Leaf nodes (depth=0) freeze raw message chunks; once condenseFanout leaves
// accumulate they condense into a depth-1 overview. assemble() injects each
// ACTIVE node as its own placeholder block so early topics survive in their own
// block instead of being diluted by a single rolling summary.

import { estimateTokens } from './tokens.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

export interface SummaryNode {
  /** Stable, sortable id: `d{depth}-{coverStartTurn}-{coverEndTurn}`. */
  id: string
  /** 0 = leaf (summarizes raw messages); 1+ = condensed (summarizes lower nodes). */
  depth: number
  /** Coverage in USER-TURN ordinals (1-based, inclusive). */
  coverStartTurn: number
  coverEndTurn: number
  /** messages.length at the moment this node's coverage ended (incremental cursor). */
  coverEndMsgCount: number
  /** The 6-section handoff note text. */
  content: string
  /** depth>=1: ids of the lower-depth nodes this one condensed. */
  childIds?: string[]
  estTokens: number
  createdAtMs: number
  model?: string
}

export interface LayeredConfig {
  leafChunkTokens: number
  condenseFanout: number
  maxSummaryDepth: number
  summaryKeepRecentTurns: number
}

export interface SummaryPlan {
  /** A new depth-0 leaf to produce: raw messages [startMsg, endMsg) covering turns. */
  leaf?: { startMsg: number; endMsg: number; startTurn: number; endTurn: number }
  /** Combine these same-depth nodes into depth+1. */
  condense?: { depth: number; childIds: string[]; startTurn: number; endTurn: number; childContents: string[] }
}

/** Count user turns within msgs[0, end). */
export function countUserTurnsUpTo(msgs: readonly Message[], end: number): number {
  let n = 0
  for (let i = 0; i < end && i < msgs.length; i++) if (msgs[i]?.role === 'user') n++
  return n
}

/**
 * Snap an index to a clean user-turn boundary: first message at or after `idx`
 * whose role is 'user'. Returns `limit` if none found.
 */
export function snapToUserEdge(msgs: readonly Message[], idx: number, limit: number): number {
  for (let i = Math.max(0, idx); i < limit && i < msgs.length; i++) {
    if (msgs[i]?.role === 'user') return i
  }
  return Math.min(limit, msgs.length)
}

/**
 * Oldest message index still foldable: start of the (keepRecentTurns+1)-th
 * most-recent user turn before frozenStart. Returns 0 if nothing old enough.
 */
export function resolveKeepTailBoundary(msgs: readonly Message[], frozenStart: number, keepTurns: number): number {
  let userSeen = 0
  for (let i = frozenStart - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      userSeen++
      if (userSeen > keepTurns) return i
    }
  }
  return 0
}

function sliceTokens(msgs: readonly Message[], start: number, end: number): number {
  let t = 0
  for (let i = start; i < end && i < msgs.length; i++) {
    const blocks = msgs[i]?.content ?? []
    for (const b of blocks) {
      if (b.type === 'text') t += estimateTokens(b.text)
    }
  }
  return t
}

/**
 * Active nodes = those NOT shadowed by a higher node's childIds, sorted by
 * coverage time (earliest first).
 */
export function activeSummaryNodes(nodes: SummaryNode[]): SummaryNode[] {
  const shadowed = new Set<string>()
  for (const n of nodes) for (const c of n.childIds ?? []) shadowed.add(c)
  return nodes.filter((n) => !shadowed.has(n.id)).sort((a, b) => a.coverStartTurn - b.coverStartTurn)
}

/**
 * How many leading messages are covered by summaries (fold boundary).
 * Returns { coverEnd, activeNodes }.
 */
export function resolveMultiCoverEnd(
  msgs: readonly Message[],
  frozenStart: number,
  nodes: SummaryNode[],
): { coverEnd: number; activeNodes: SummaryNode[] } {
  const active = activeSummaryNodes(nodes)
  if (!active.length) return { coverEnd: 0, activeNodes: [] }
  const maxTurn = Math.max(...active.map((n) => n.coverEndTurn))
  let userSeen = 0
  let coverEnd = 0
  for (let i = 0; i < frozenStart && i < msgs.length; i++) {
    if (msgs[i]?.role === 'user') {
      userSeen++
      if (userSeen > maxTurn) {
        coverEnd = i
        break
      }
    }
  }
  return { coverEnd: Math.min(coverEnd === 0 ? frozenStart : coverEnd, frozenStart), activeNodes: active }
}

/**
 * Decide the next summary work (pure). At most one leaf and/or one condense.
 * Leaf: when unfrozen foldable raw messages exceed leafChunkTokens.
 * Condense: when >= condenseFanout same-depth nodes are uncondensed (and no leaf this round).
 */
export function planSummaryJobs(
  msgs: readonly Message[],
  frozenStart: number,
  nodes: SummaryNode[],
  leafCursorMsg: number,
  cfg: LayeredConfig,
): SummaryPlan {
  const plan: SummaryPlan = {}

  const keepTail = resolveKeepTailBoundary(msgs, frozenStart, cfg.summaryKeepRecentTurns)
  const start = Math.max(0, leafCursorMsg)
  if (keepTail > start) {
    let acc = 0
    let end = start
    for (let i = start; i < keepTail; i++) {
      const blocks = msgs[i]?.content ?? []
      for (const b of blocks) {
        if (b.type === 'text') acc += estimateTokens(b.text)
      }
      end = i + 1
      if (acc >= cfg.leafChunkTokens) break
    }
    if (acc >= cfg.leafChunkTokens || (end >= keepTail && sliceTokens(msgs, start, end) >= cfg.leafChunkTokens)) {
      const snapped = snapToUserEdge(msgs, end, keepTail)
      const endMsg = snapped > start ? snapped : end
      if (endMsg > start) {
        const startTurn = countUserTurnsUpTo(msgs, start) + 1
        const endTurn = countUserTurnsUpTo(msgs, endMsg)
        if (endTurn >= startTurn) {
          plan.leaf = { startMsg: start, endMsg, startTurn, endTurn }
        }
      }
    }
  }

  if (!plan.leaf && cfg.maxSummaryDepth >= 1) {
    const shadowed = new Set<string>()
    for (const n of nodes) for (const c of n.childIds ?? []) shadowed.add(c)
    for (let d = 0; d < cfg.maxSummaryDepth; d++) {
      const uncondensed = nodes
        .filter((n) => n.depth === d && !shadowed.has(n.id))
        .sort((a, b) => a.coverStartTurn - b.coverStartTurn)
      if (uncondensed.length >= cfg.condenseFanout) {
        const batch = uncondensed.slice(0, cfg.condenseFanout)
        plan.condense = {
          depth: d + 1,
          childIds: batch.map((n) => n.id),
          startTurn: batch[0].coverStartTurn,
          endTurn: batch[batch.length - 1].coverEndTurn,
          childContents: batch.map((n) => n.content),
        }
        break
      }
    }
  }

  return plan
}

export function nodeId(depth: number, startTurn: number, endTurn: number): string {
  return `d${depth}-${startTurn}-${endTurn}`
}

/**
 * Build a placeholder message text for injecting a summary node into the context.
 * Idempotent: same node content → byte-identical text (no timestamps/random),
 * so the KV-cache prefix stays stable once committed.
 */
export function buildLayeredPlaceholderText(node: SummaryNode): string {
  const span = `turns ${node.coverStartTurn}-${node.coverEndTurn}`
  const tag = node.depth === 0 ? 'flowctx-history-summary' : 'flowctx-history-summary-condensed'
  return (
    `[flowctx-dsh: summary layer depth=${node.depth} covering ${span}. ` +
    `Retrieve via flowctx_retrieve(node="${node.id}").]\n` +
    `<${tag} depth="${node.depth}" span="${span}">\n${node.content}\n</${tag}>`
  )
}
