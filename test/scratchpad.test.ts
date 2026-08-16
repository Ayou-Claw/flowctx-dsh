import { describe, it, expect } from 'vitest'
import { Scratchpad } from '../src/scratchpad.ts'
import type { KvStore } from '../src/db/kv-store.ts'

/** In-memory stand-in for KvStore that records put/get by (ns,key). */
function fakeKv(available = true) {
  const rows = new Map<string, string>()
  const k = (ns: string, key: string) => `${ns}::${key}`
  const putCalls: Array<{ ns: string; key: string; value: string; expiresAtMs: number | null }> = []
  const getCalls: Array<{ ns: string; key: string }> = []
  const kv = {
    available,
    putSync(ns: string, key: string, value: string, expiresAtMs: number | null) {
      putCalls.push({ ns, key, value, expiresAtMs })
      rows.set(k(ns, key), value)
    },
    get(ns: string, key: string) {
      getCalls.push({ ns, key })
      return rows.get(k(ns, key)) ?? null
    },
  } as unknown as KvStore
  const seed = (ns: string, key: string, value: string) => rows.set(k(ns, key), value)
  const read = (ns: string, key: string) => rows.get(k(ns, key))
  return { kv, rows, putCalls, getCalls, seed, read }
}

describe('Scratchpad', () => {
  it('returns empty string for unknown session', () => {
    const sp = new Scratchpad(1000)
    expect(sp.get('unknown')).toBe('')
  })

  it('render() returns null when empty', () => {
    const sp = new Scratchpad(1000)
    expect(sp.render('s1')).toBeNull()
  })

  describe('append()', () => {
    it('appends text on first call', () => {
      const sp = new Scratchpad(1000)
      const result = sp.append('s1', 'first line')
      expect(result).toBe('first line')
      expect(sp.get('s1')).toBe('first line')
    })

    it('appends subsequent calls with newline separator', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'line one')
      const result = sp.append('s1', 'line two')
      expect(result).toBe('line one\nline two')
    })

    it('sessions are isolated', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'for s1')
      sp.append('s2', 'for s2')
      expect(sp.get('s1')).toBe('for s1')
      expect(sp.get('s2')).toBe('for s2')
    })
  })

  describe('replace()', () => {
    it('replaces first occurrence', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'todo: buy milk\ntodo: buy eggs')
      const result = sp.replace('s1', 'buy milk', 'buy bread')
      expect(result).toContain('buy bread')
      expect(result).not.toContain('buy milk')
    })

    it('only replaces first occurrence when there are duplicates', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'x x x')
      sp.replace('s1', 'x', 'y')
      expect(sp.get('s1')).toBe('y x x')
    })

    it('no-op when old_text not found', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'original content')
      sp.replace('s1', 'missing', 'new')
      expect(sp.get('s1')).toBe('original content')
    })
  })

  describe('rethink()', () => {
    it('replaces entire content', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'old line 1')
      sp.append('s1', 'old line 2')
      const result = sp.rethink('s1', 'brand new content')
      expect(result).toBe('brand new content')
      expect(sp.get('s1')).toBe('brand new content')
    })

    it('can clear content with empty string', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'something')
      sp.rethink('s1', '')
      expect(sp.get('s1')).toBe('')
    })
  })

  describe('maxChars clamping', () => {
    it('clamps content to maxChars', () => {
      const sp = new Scratchpad(10)
      const result = sp.append('s1', 'x'.repeat(20))
      expect(result.length).toBe(10)
    })

    it('clamps rethink content', () => {
      const sp = new Scratchpad(5)
      const result = sp.rethink('s1', 'abcdefghij')
      expect(result).toBe('abcde')
    })
  })

  describe('render()', () => {
    it('returns working_memory XML block when content present', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'remember this')
      const rendered = sp.render('s1')
      expect(rendered).toContain('<working_memory')
      expect(rendered).toContain('remember this')
      expect(rendered).toContain('</working_memory>')
    })

    it('includes chars_current and chars_limit attributes', () => {
      const sp = new Scratchpad(1000)
      sp.append('s1', 'test')
      const rendered = sp.render('s1')!
      expect(rendered).toContain('chars_current="4"')
      expect(rendered).toContain('chars_limit="1000"')
    })
  })

  describe('SQLite persistence', () => {
    const NS = 'scratchpad'

    it('persists appended content to the KvStore', () => {
      const { kv, putCalls } = fakeKv()
      const sp = new Scratchpad(1000, { kv, ns: NS })
      sp.append('s1', 'remember this')
      const last = putCalls.at(-1)!
      expect(last.ns).toBe(NS)
      expect(last.key).toBe('s1')
      expect(last.value).toBe('remember this')
      expect(last.expiresAtMs).toBeNull()
    })

    it('persists replace and rethink mutations', () => {
      const { kv, read } = fakeKv()
      const sp = new Scratchpad(1000, { kv })
      sp.append('s1', 'todo: buy milk')
      sp.replace('s1', 'buy milk', 'buy bread')
      expect(read(NS, 's1')).toBe('todo: buy bread')
      sp.rethink('s1', 'clean slate')
      expect(read(NS, 's1')).toBe('clean slate')
    })

    it('re-hydrates persisted content into a fresh instance (restart path)', () => {
      const { kv, seed } = fakeKv()
      // Simulate a prior process having persisted content.
      seed(NS, 's1', 'survived restart')
      const sp = new Scratchpad(1000, { kv })
      expect(sp.get('s1')).toBe('survived restart')
      expect(sp.render('s1')).toContain('survived restart')
    })

    it('appends onto re-hydrated content without losing the prefix', () => {
      const { kv, seed, read } = fakeKv()
      seed(NS, 's1', 'old note')
      const sp = new Scratchpad(1000, { kv })
      const result = sp.append('s1', 'new note')
      expect(result).toBe('old note\nnew note')
      expect(read(NS, 's1')).toBe('old note\nnew note')
    })

    it('reads from KvStore at most once per session (hot after hydration)', () => {
      const { kv, seed, getCalls } = fakeKv()
      seed(NS, 's1', 'content')
      const sp = new Scratchpad(1000, { kv })
      sp.get('s1')
      sp.get('s1')
      sp.render('s1')
      const s1Reads = getCalls.filter((c) => c.key === 's1')
      expect(s1Reads.length).toBe(1)
    })

    it('does not touch KvStore when unavailable', () => {
      const { kv, putCalls, getCalls } = fakeKv(false)
      const sp = new Scratchpad(1000, { kv })
      sp.append('s1', 'x')
      expect(sp.get('s1')).toBe('x')
      expect(putCalls.length).toBe(0)
      expect(getCalls.length).toBe(0)
    })

    it('persists clamped (not raw) content', () => {
      const { kv, read } = fakeKv()
      const sp = new Scratchpad(5, { kv })
      sp.append('s1', 'abcdefghij')
      expect(read(NS, 's1')).toBe('abcde')
    })
  })
})
