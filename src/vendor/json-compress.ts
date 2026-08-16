// Vendored & adapted from tokenjuice (MIT). Deterministic, pure-TS reducers:
// JSON lexical minify, hashed middle-clip, git-diff hunk compaction, per-line clip.
//
// All reducers here are LOSSY *views*; byte-exact reversibility is guaranteed by
// the caller (projection.ts stores the original in CompressionStore by hash, so
// flowctx_retrieve returns the exact source). The embedded sha256[:12] is an
// integrity fingerprint.

import { createHash } from "node:crypto"

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

/**
 * Clip a long string to maxChars, keeping head 55% + tail 45% with a hashed
 * middle marker.
 */
export function clipMiddleWithHash(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const omitted = text.length - maxChars
	const headChars = Math.max(20, Math.floor(maxChars * 0.55))
	const tailChars = Math.max(20, maxChars - headChars)
	return `${text.slice(0, headChars)} ...[${omitted} chars omitted, sha256:${shortHash(text)}]... ${text.slice(-tailChars)}`
}

/**
 * Strict head 70% + tail 30% middle clip (used for minified JSON).
 *
 */
function clipMiddleStrict(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const omitted = text.length - maxChars
	const marker = `...[${omitted} chars omitted, sha256:${shortHash(text)}]...`
	if (maxChars <= marker.length) return marker.slice(0, maxChars)
	const body = maxChars - marker.length
	const head = Math.ceil(body * 0.7)
	const tail = Math.max(0, body - head)
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`
}

/**
 * Lexical JSON whitespace minify — strips whitespace OUTSIDE strings in O(n),
 * never touching string contents.
 */
export function minifyJsonLexically(rawText: string): string {
	const text = rawText.trim()
	let output = ""
	let inString = false
	let escaped = false
	for (const char of text) {
		if (inString) {
			output += char
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			output += char
			continue
		}
		if (/\s/u.test(char)) continue
		output += char
	}
	return output
}

function isJsonText(text: string): boolean {
	const t = text.trim()
	if (!(t.startsWith("{") || t.startsWith("["))) return false
	try {
		JSON.parse(t)
		return true
	} catch {
		return false
	}
}

/**
 * Minify a whole JSON document, then clip to maxChars if still too long.
 * Returns null if the text is not JSON.
 */
export function compactWholeJsonText(rawText: string, maxChars: number): string | null {
	if (!isJsonText(rawText)) return null
	return clipMiddleStrict(minifyJsonLexically(rawText), maxChars)
}

// --- git diff hunk compaction ---

const GIT_DIFF_CHANGED_LINES_PER_HUNK = 8
const LONG_CHANGED_LINE_MAX_CHARS = 260

/**
 * Compact a unified git diff: keep every file/hunk header (diff --git, ---, +++,
 * @@) and the first N changed (+/-) lines per hunk, dropping context lines and
 * excess changes. Long changed lines are clipped. Adapted from the vendored source
 * rewriteGitDiffLines.
 */
export function compactGitDiff(text: string): string {
	const lines = text.split("\n")
	const out: string[] = []
	let changedInHunk = 0
	let droppedInHunk = 0
	const flushDrop = () => {
		if (droppedInHunk > 0) {
			out.push(`  …[${droppedInHunk} more changed line(s) in hunk omitted]…`)
			droppedInHunk = 0
		}
	}
	for (const line of lines) {
		const isHeader =
			line.startsWith("diff --git ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("@@")
		if (isHeader) {
			flushDrop()
			changedInHunk = 0
			out.push(line)
			continue
		}
		const isChange = line.startsWith("+") || line.startsWith("-")
		if (isChange) {
			if (changedInHunk < GIT_DIFF_CHANGED_LINES_PER_HUNK) {
				out.push(
					line.length > LONG_CHANGED_LINE_MAX_CHARS
						? clipMiddleWithHash(line, LONG_CHANGED_LINE_MAX_CHARS)
						: line,
				)
				changedInHunk++
			} else {
				droppedInHunk++
			}
			continue
		}
		// context line → drop (the hunk header already carries the location)
	}
	flushDrop()
	return out.join("\n")
}

// --- search/grep line clipping ---

const LONG_SEARCH_LINE_MAX_CHARS = 320

/**
 * Compact grep/ripgrep/git-grep output: keep every `path:line:` (or `path:line-`)
 * locator prefix, clip only the long matched CONTENT after it. Lines without a
 * locator are clipped whole. Adapted from the vendored source rewriteSearchLines — content
 * driven (no tool name needed), so it works on flowctx's tool results which carry
 * no toolName. Lossy view; original is in the CompressionStore by hash.
 */
export function compactSearchLines(text: string): string {
	const lines = text.split("\n")
	const out = lines.map((line) => {
		const m = /^(.+?:\d+(?::|-))(.*)$/u.exec(line)
		if (!m) return clipMiddleWithHash(line, LONG_SEARCH_LINE_MAX_CHARS)
		const [, prefix, rest] = m
		return `${prefix}${clipMiddleWithHash(rest ?? "", LONG_SEARCH_LINE_MAX_CHARS)}`
	})
	return out.join("\n")
}
