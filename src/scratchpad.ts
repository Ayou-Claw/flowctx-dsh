// Working-memory scratchpad — ported from flowctx.
// Session-scoped, in-memory model-editable <working_memory> block.
// Three surgical mutation ops: append / replace / rethink.
// SQLite persistence omitted; DSH session handles durability.

export class Scratchpad {
  private blocks = new Map<string, string>()
  private readonly maxChars: number

  constructor(maxChars: number) {
    this.maxChars = maxChars
  }

  get(sessionKey: string): string {
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
    return clamped
  }
}
