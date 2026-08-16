/**
 * Engineer handoff-note summarization prompt for flowctx-dsh.
 *
 * The system prompt and instruction together produce a structured ENGINEER
 * HANDOFF NOTE rather than a generic chat summary. The style front-loads
 * actionable state so any model resuming after compaction can immediately
 * continue the work without re-reading prior context.
 */

export const HANDOFF_SYSTEM_PROMPT = `You are a senior engineer writing a concise handoff note for your team. Your task is to distill a conversation into a structured note that lets another engineer resume the work with zero loss of essential state. Be terse, precise, and exhaustive on facts — omit social niceties and meta-commentary.`

export const HANDOFF_INSTRUCTION = `
Write an ENGINEER HANDOFF NOTE for the conversation above. Use exactly the six sections below, in order. Each section uses terse bullet points, not prose. Write "(none)" for an empty section — never omit a section.

---

## TASK / GOAL
- [The user's original request and any subsequent scope changes — include verbatim wording when exact phrasing matters]

## WORKING APPROACHES
- [Designs, implementations, or decisions that were validated and are worth building on — include relevant file paths, function names, and commands]

## FAILED APPROACHES
- [What was tried and did NOT work, and why — be explicit about failure mode so future engineers don't repeat the mistake]

## KEY IDENTIFIERS
- [File paths, function/type/variable names, CLI commands, URLs, config keys, env vars, and numeric values that must be preserved exactly]

## FILE ARTIFACTS
- [Every file that was created, modified, or deleted — note current state and what it does]

## OPEN STATE
- [Exactly what was in progress at cut-off, any pending tasks not yet done, and the single next action the resuming engineer should take]

---

Rules:
- Preserve exact identifiers: file paths, error strings, function signatures, CLI flags, numeric values.
- Capture user corrections and explicit preferences faithfully.
- Do NOT mention this summarization or that the context was compacted.
- Output only the handoff note text — no tool calls, no preamble.
- If the conversation already contains a prior handoff note, consolidate: keep still-true facts, discard stale ones, and produce ONE merged note.
`.trim()
