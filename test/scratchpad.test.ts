import { describe, it, expect } from 'vitest'
import { Scratchpad } from '../src/scratchpad.ts'

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
})
