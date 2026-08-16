import { describe, it, expect } from 'vitest'
import { detectContentType, compressStructured } from '../src/structured.ts'

describe('detectContentType()', () => {
  it('detects JSON object', () => {
    expect(detectContentType('{"key": "value", "num": 42}')).toBe('json')
  })

  it('detects JSON array', () => {
    expect(detectContentType('[1, 2, 3]')).toBe('json')
  })

  it('detects git diff', () => {
    const diff = `diff --git a/file.ts b/file.ts\nindex abc..def 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@`
    expect(detectContentType(diff)).toBe('diff')
  })

  it('detects code by tool name extension', () => {
    expect(detectContentType('const x = 1\nconst y = 2', 'read file.ts')).toBe('code')
  })

  it('detects code by keywords', () => {
    const code = `import { foo } from 'bar'\nexport const baz = 42\nfunction qux() { return 1 }\nconst x = baz`
    expect(detectContentType(code)).toBe('code')
  })

  it('detects search output (file:line pattern)', () => {
    const search = Array.from({ length: 10 }, (_, i) =>
      `src/file${i}.ts:${i + 1}: some match here`
    ).join('\n')
    expect(detectContentType(search)).toBe('search')
  })

  it('detects log output (level-prefixed format)', () => {
    // LOG_RE matches INFO/WARN/ERROR/DEBUG at line start, or YYYY-MM-DD, or [digit
    const log = Array.from({ length: 25 }, (_, i) =>
      `INFO processing item ${i} done`
    ).join('\n')
    expect(detectContentType(log)).toBe('log')
  })

  it('detects test output', () => {
    expect(detectContentType('1 passed, 0 failed\nTest Suite Passed')).toBe('test')
  })

  it('falls back to cli-output for generic multi-line content', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: some output here`).join('\n')
    expect(detectContentType(lines)).toBe('cli-output')
  })

  it('falls back to text for short content', () => {
    expect(detectContentType('just a short line')).toBe('text')
  })
})

describe('compressStructured()', () => {
  it('compresses large JSON array (>=20 items)', () => {
    const json = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 100 }))
    )
    const result = compressStructured(json)
    expect(result.contentType).toBe('json')
  })

  it('returns null text when content cannot be meaningfully compressed', () => {
    const short = 'hello world'
    const result = compressStructured(short)
    expect(result.text).toBeNull()
  })

  it('contentType is always set', () => {
    const cases = [
      '{"x":1}',
      'diff --git a b\n@@ -1 +1 @@',
      'import x from y\nconst z = 1\nfunction a(){}\n'.repeat(5),
      'hello',
    ]
    for (const c of cases) {
      const result = compressStructured(c)
      expect(result.contentType).toBeTruthy()
    }
  })

  it('compressed output is shorter than input when compression succeeds', () => {
    // Large JSON array (>=20 items triggers explore path)
    const bigArray = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `This is item number ${i} with a longer description`,
      value: i * 100,
    })))
    const result = compressStructured(bigArray)
    if (result.text !== null) {
      expect(result.text.length).toBeLessThan(bigArray.length)
    }
  })
})
