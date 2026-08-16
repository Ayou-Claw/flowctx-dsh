import { describe, it, expect } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  countUserTurnsUpTo,
  snapToUserEdge,
  resolveKeepTailBoundary,
  activeSummaryNodes,
  planSummaryJobs,
  nodeId,
  buildLayeredPlaceholderText,
  type SummaryNode,
  type LayeredConfig,
} from '../src/summary-tree.ts'

// ---- helpers ----

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message
}

function assistantMsg(text = 'ok'): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] } as Message
}

function makeNode(
  depth: number,
  startTurn: number,
  endTurn: number,
  childIds?: string[],
): SummaryNode {
  const id = nodeId(depth, startTurn, endTurn)
  return {
    id, depth, coverStartTurn: startTurn, coverEndTurn: endTurn,
    coverEndMsgCount: endTurn * 2, content: `## TASK\n- turn ${startTurn}-${endTurn}`,
    estTokens: 50, createdAtMs: 0,
    ...(childIds ? { childIds } : {}),
  }
}

const CFG: LayeredConfig = {
  leafChunkTokens: 1000,
  condenseFanout: 3,
  maxSummaryDepth: 1,
  summaryKeepRecentTurns: 1,
}

// ---- countUserTurnsUpTo ----

describe('countUserTurnsUpTo()', () => {
  it('counts user messages up to end index (exclusive)', () => {
    const msgs = [userMsg('a'), assistantMsg(), userMsg('b'), assistantMsg()]
    expect(countUserTurnsUpTo(msgs, 4)).toBe(2)
    expect(countUserTurnsUpTo(msgs, 2)).toBe(1)
    expect(countUserTurnsUpTo(msgs, 0)).toBe(0)
  })

  it('returns 0 for empty array', () => {
    expect(countUserTurnsUpTo([], 0)).toBe(0)
  })
})

// ---- snapToUserEdge ----

describe('snapToUserEdge()', () => {
  it('returns the index of the next user message at or after idx', () => {
    const msgs = [assistantMsg(), assistantMsg(), userMsg('x'), assistantMsg()]
    expect(snapToUserEdge(msgs, 0, msgs.length)).toBe(2)
  })

  it('returns limit when no user message found', () => {
    const msgs = [assistantMsg(), assistantMsg()]
    expect(snapToUserEdge(msgs, 0, msgs.length)).toBe(msgs.length)
  })

  it('returns idx when that position is already a user message', () => {
    const msgs = [userMsg('a'), assistantMsg()]
    expect(snapToUserEdge(msgs, 0, msgs.length)).toBe(0)
  })
})

// ---- resolveKeepTailBoundary ----

describe('resolveKeepTailBoundary()', () => {
  const msgs = [
    userMsg('t1'), assistantMsg(), // turn 1
    userMsg('t2'), assistantMsg(), // turn 2
    userMsg('t3'), assistantMsg(), // turn 3
    userMsg('t4'), assistantMsg(), // turn 4
  ]

  it('returns 0 when keepTurns covers all user messages', () => {
    // keepTurns=4 keeps all 4 user turns → nothing is foldable
    expect(resolveKeepTailBoundary(msgs, msgs.length, 4)).toBe(0)
  })

  it('returns index of first user msg outside keepTurns window', () => {
    // keepTurns=1: keep the last 1 user turn → fold boundary is at the 3rd user turn (index 4)
    const idx = resolveKeepTailBoundary(msgs, msgs.length, 1)
    expect(msgs[idx]?.role).toBe('user')
  })

  it('returns 0 for empty messages', () => {
    expect(resolveKeepTailBoundary([], 0, 2)).toBe(0)
  })
})

// ---- activeSummaryNodes ----

describe('activeSummaryNodes()', () => {
  it('returns all nodes when none are shadowed', () => {
    const nodes = [makeNode(0, 1, 3), makeNode(0, 4, 6)]
    expect(activeSummaryNodes(nodes)).toHaveLength(2)
  })

  it('excludes nodes that are childIds of a higher node', () => {
    const leaf1 = makeNode(0, 1, 3)
    const leaf2 = makeNode(0, 4, 6)
    const leaf3 = makeNode(0, 7, 9)
    const condensed = makeNode(1, 1, 9, [leaf1.id, leaf2.id, leaf3.id])
    const active = activeSummaryNodes([leaf1, leaf2, leaf3, condensed])
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(condensed.id)
  })

  it('returns nodes sorted by coverStartTurn', () => {
    const nodes = [makeNode(0, 4, 6), makeNode(0, 1, 3), makeNode(0, 7, 9)]
    const active = activeSummaryNodes(nodes)
    expect(active.map((n) => n.coverStartTurn)).toEqual([1, 4, 7])
  })
})

// ---- planSummaryJobs ----

describe('planSummaryJobs()', () => {
  it('returns no leaf when there are not enough tokens', () => {
    const msgs = [userMsg('tiny'), assistantMsg()]
    const plan = planSummaryJobs(msgs, msgs.length, [], 0, CFG)
    expect(plan.leaf).toBeUndefined()
  })

  it('plans a leaf when foldable region exceeds leafChunkTokens', () => {
    // Use a small leafChunkTokens (200) so a few messages are enough to trigger.
    // Each user msg = 'word '.repeat(50) ~250 chars → ~63 ASCII tokens.
    // With summaryKeepRecentTurns=1 and 10 turns, keepTail covers msgs[0..14),
    // giving ~7 user msgs × 63 tokens = ~441 tokens > leafChunkTokens=200.
    const smallCfg: LayeredConfig = { ...CFG, leafChunkTokens: 200 }
    const msgs: Message[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(userMsg('word '.repeat(50)))
      msgs.push(assistantMsg('ok'))
    }
    const frozenStart = msgs.length - 2
    const plan = planSummaryJobs(msgs, frozenStart, [], 0, smallCfg)
    expect(plan.leaf).toBeDefined()
    expect(plan.leaf!.startMsg).toBe(0)
    expect(plan.leaf!.endMsg).toBeGreaterThan(0)
  })

  it('plans a condense when condenseFanout leaves accumulate', () => {
    const leaves = [makeNode(0, 1, 3), makeNode(0, 4, 6), makeNode(0, 7, 9)]
    const msgs = [userMsg('current'), assistantMsg()]
    const plan = planSummaryJobs(msgs, msgs.length, leaves, 18, CFG)
    expect(plan.condense).toBeDefined()
    expect(plan.condense!.depth).toBe(1)
    expect(plan.condense!.childIds).toHaveLength(3)
  })

  it('does not plan condense when below fanout threshold', () => {
    const leaves = [makeNode(0, 1, 3), makeNode(0, 4, 6)] // only 2, need 3
    const msgs = [userMsg('current'), assistantMsg()]
    const plan = planSummaryJobs(msgs, msgs.length, leaves, 8, CFG)
    expect(plan.condense).toBeUndefined()
  })

  it('prefers leaf over condense when both would trigger', () => {
    // 3 leaves ready + enough raw messages for a leaf (use small leafChunkTokens)
    const smallCfg: LayeredConfig = { ...CFG, leafChunkTokens: 200 }
    const leaves = [makeNode(0, 1, 3), makeNode(0, 4, 6), makeNode(0, 7, 9)]
    const msgs: Message[] = [...Array.from({ length: 10 }, (_, i) => [
      userMsg('word '.repeat(50) + `turn${i}`),
      assistantMsg(),
    ]).flat()]
    const frozenStart = msgs.length - 2
    const plan = planSummaryJobs(msgs, frozenStart, leaves, 0, smallCfg)
    // leaf takes priority over condense
    expect(plan.leaf).toBeDefined()
  })
})

// ---- nodeId ----

describe('nodeId()', () => {
  it('formats as d{depth}-{start}-{end}', () => {
    expect(nodeId(0, 1, 5)).toBe('d0-1-5')
    expect(nodeId(1, 3, 9)).toBe('d1-3-9')
  })
})

// ---- buildLayeredPlaceholderText ----

describe('buildLayeredPlaceholderText()', () => {
  it('includes node id and span', () => {
    const node = makeNode(0, 1, 5)
    const text = buildLayeredPlaceholderText(node)
    expect(text).toContain(node.id)
    expect(text).toContain('turns 1-5')
  })

  it('uses flowctx-history-summary tag for depth-0', () => {
    const node = makeNode(0, 1, 3)
    expect(buildLayeredPlaceholderText(node)).toContain('<flowctx-history-summary ')
    expect(buildLayeredPlaceholderText(node)).not.toContain('condensed')
  })

  it('uses flowctx-history-summary-condensed tag for depth>=1', () => {
    const node = makeNode(1, 1, 9)
    expect(buildLayeredPlaceholderText(node)).toContain('<flowctx-history-summary-condensed ')
  })

  it('includes node content inside tag', () => {
    const node = makeNode(0, 2, 4)
    const text = buildLayeredPlaceholderText(node)
    expect(text).toContain(node.content)
  })

  it('is idempotent (same node → same output)', () => {
    const node = makeNode(0, 1, 3)
    expect(buildLayeredPlaceholderText(node)).toBe(buildLayeredPlaceholderText(node))
  })
})
