import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateTokensMany, truncateTextToEstimatedTokens } from '../src/tokens.ts'

describe('estimateTokens()', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('ASCII text: ~0.25 tokens/char (rounded up)', () => {
    // 4 ASCII chars → 1 token
    expect(estimateTokens('abcd')).toBe(1)
    // 1 char → ceil(0.25) = 1
    expect(estimateTokens('a')).toBe(1)
    // 8 chars → 2 tokens
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('CJK text: ~1.5 tokens/char', () => {
    // 1 CJK char → ceil(1.5) = 2
    expect(estimateTokens('中')).toBe(2)
    // 2 CJK chars → ceil(3) = 3
    expect(estimateTokens('中文')).toBe(3)
    // 4 CJK chars → ceil(6) = 6
    expect(estimateTokens('你好世界')).toBe(6)
  })

  it('emoji/SMP: ~2 tokens/char', () => {
    // single emoji → 2
    expect(estimateTokens('😀')).toBe(2)
    // two emojis → 4
    expect(estimateTokens('😀🎉')).toBe(4)
  })

  it('mixed content weights proportionally', () => {
    const ascii4 = 'abcd'   // 1 tok
    const cjk2 = '中文'     // 3 tok
    const emoji1 = '😀'    // 2 tok
    const mixed = ascii4 + cjk2 + emoji1
    expect(estimateTokens(mixed)).toBe(1 + 3 + 2)
  })

  it('always returns a positive integer', () => {
    const result = estimateTokens('x')
    expect(Number.isInteger(result)).toBe(true)
    expect(result).toBeGreaterThan(0)
  })
})

describe('estimateTokensMany()', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokensMany([])).toBe(0)
  })

  it('sums tokens across strings', () => {
    expect(estimateTokensMany(['abcd', 'abcd'])).toBe(2)
  })

  it('handles mixed content in array', () => {
    const total = estimateTokensMany(['abcd', '中文', '😀'])
    expect(total).toBe(1 + 3 + 2)
  })
})

describe('truncateTextToEstimatedTokens()', () => {
  it('returns text unchanged when already under limit', () => {
    expect(truncateTextToEstimatedTokens('hello', 100)).toBe('hello')
  })

  it('truncates long ASCII text to approximately the token limit', () => {
    const text = 'a'.repeat(1000) // ~250 tokens
    const result = truncateTextToEstimatedTokens(text, 100)
    expect(estimateTokens(result)).toBeLessThanOrEqual(100)
    expect(result.length).toBeLessThan(text.length)
  })

  it('result tokens are at most the limit', () => {
    const text = '中'.repeat(200) // 300 tokens
    const limit = 50
    const result = truncateTextToEstimatedTokens(text, limit)
    expect(estimateTokens(result)).toBeLessThanOrEqual(limit)
  })

  it('empty string input returns empty string', () => {
    expect(truncateTextToEstimatedTokens('', 10)).toBe('')
  })
})
