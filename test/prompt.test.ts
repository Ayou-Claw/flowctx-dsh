import { describe, it, expect } from 'vitest'
import { HANDOFF_SYSTEM_PROMPT, HANDOFF_INSTRUCTION } from '../src/prompt.ts'

describe('HANDOFF_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof HANDOFF_SYSTEM_PROMPT).toBe('string')
    expect(HANDOFF_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it('does not mention OpenClaw or openclaw', () => {
    expect(HANDOFF_SYSTEM_PROMPT.toLowerCase()).not.toContain('openclaw')
  })
})

describe('HANDOFF_INSTRUCTION', () => {
  it('is a non-empty string', () => {
    expect(typeof HANDOFF_INSTRUCTION).toBe('string')
    expect(HANDOFF_INSTRUCTION.length).toBeGreaterThan(0)
  })

  it('contains all six required sections', () => {
    expect(HANDOFF_INSTRUCTION).toContain('## TASK / GOAL')
    expect(HANDOFF_INSTRUCTION).toContain('## WORKING APPROACHES')
    expect(HANDOFF_INSTRUCTION).toContain('## FAILED APPROACHES')
    expect(HANDOFF_INSTRUCTION).toContain('## KEY IDENTIFIERS')
    expect(HANDOFF_INSTRUCTION).toContain('## FILE ARTIFACTS')
    expect(HANDOFF_INSTRUCTION).toContain('## OPEN STATE')
  })

  it('does not mention OpenClaw or openclaw', () => {
    expect(HANDOFF_INSTRUCTION.toLowerCase()).not.toContain('openclaw')
  })

  it('instructs not to mention the summarization itself', () => {
    expect(HANDOFF_INSTRUCTION).toContain('Do NOT mention this summarization')
  })

  it('handles prior handoff-note consolidation', () => {
    expect(HANDOFF_INSTRUCTION).toContain('prior handoff note')
  })
})
