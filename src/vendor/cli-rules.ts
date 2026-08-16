// CLI tool-result rule engine — algorithm ported from opensquilla (Apache-2.0),
// whose rule engine derives from tokenjuice (MIT). Pure TS,
// no fs/host machinery: rules are a pre-baked array (rather than loaded from disk)
// so the esbuild bundle stays self-contained.
//
// Reduction is a LOSSY view; byte-exact reversibility is guaranteed by the caller
// (projection.ts stores the original by hash). The reducer applies, in order:
//   1. outputMatches short-circuit (entire output → a fixed terminal string),
//   2. stripAnsi / trimEmptyEdges / dedupeAdjacent,
//   3. skipPatterns (drop) then keepPatterns (restrict),
//   4. named counter facts,
//   5. head/tail line windowing (success vs failure window by exit code).
// Two rejection guards (line-identity / not-shorter) return null so the caller
// falls back to its head/tail char slice.

export interface CliRule {
	id: string
	match: { argv0?: string[]; argvIncludes?: string[][] }
	matchOutput?: { pattern: string; message: string; flags?: string }[]
	transforms?: { stripAnsi?: boolean; dedupeAdjacent?: boolean; trimEmptyEdges?: boolean }
	filters?: { skipPatterns?: string[]; keepPatterns?: string[] }
	counters?: { name: string; pattern: string; flags?: string }[]
	summarize: { head: number; tail: number }
	failure?: { head: number; tail: number }
}

const ANSI_RE =
	// eslint-disable-next-line no-control-regex
	/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "")
}

function trimEmptyEdges(lines: string[]): string[] {
	let start = 0
	let end = lines.length
	while (start < end && lines[start].trim() === "") start++
	while (end > start && lines[end - 1].trim() === "") end--
	return lines.slice(start, end)
}

function dedupeAdjacent(lines: string[]): string[] {
	const out: string[] = []
	let last: string | null = null
	for (const line of lines) {
		if (line !== last) out.push(line)
		last = line
	}
	return out
}

function headTail(lines: string[], head: number, tail: number): string[] {
	if (lines.length <= head + tail) return lines
	const omitted = lines.length - head - tail
	return [...lines.slice(0, head), `... omitted ${omitted} lines ...`, ...lines.slice(-tail)]
}

function reFlags(flags?: string): string {
	let f = ""
	if (flags?.includes("i")) f += "i"
	if (flags?.includes("m")) f += "m"
	return f
}

function countPattern(lines: string[], pattern: string, flags?: string): number {
	const re = new RegExp(pattern, reFlags(flags))
	return lines.filter((l) => re.test(l)).length
}

/** Built-in rule subset (high-frequency families), pre-baked. Pre-baked. */
export const BUNDLED_CLI_RULES: CliRule[] = [
	{
		id: "git/status",
		match: { argv0: ["git"], argvIncludes: [["status"]] },
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		filters: {
			skipPatterns: [
				"^On branch ",
				"^Your branch is ",
				'^\\(use "git .+" to .+\\)$',
				"^no changes added to commit.*$",
				"^nothing added to commit but untracked files present.*$",
				"^nothing to commit, working tree clean$",
			],
		},
		summarize: { head: 10, tail: 4 },
		failure: { head: 12, tail: 12 },
		counters: [
			{ name: "modified file", pattern: "^(?:M:|\\s*modified:|[ MTRU][MTRU]\\s+|[MTRU][ MTRU]\\s+)" },
			{ name: "new file", pattern: "^(?:A:|\\s*new file:|A.\\s+|.A\\s+)" },
			{ name: "deleted file", pattern: "^(?:D:|\\s*deleted:|D.\\s+|.D\\s+)" },
			{ name: "untracked file", pattern: "^(?:\\?\\?:|\\?\\?\\s+|\\s*untracked files:)" },
		],
	},
	{
		id: "install/npm-ci",
		match: { argv0: ["npm"], argvIncludes: [["ci"], ["install"]] },
		matchOutput: [{ pattern: "up to date, audited \\d+ package", message: "npm: up to date", flags: "i" }],
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		filters: { skipPatterns: ["^npm notice .+"] },
		summarize: { head: 10, tail: 8 },
		failure: { head: 14, tail: 14 },
		counters: [
			{ name: "warning", pattern: "warn", flags: "i" },
			{ name: "vulnerability", pattern: "vulnerabilit", flags: "i" },
		],
	},
	{
		// Generic catch-all (sorts last). match:{} = always matches.
		id: "generic/fallback",
		match: {},
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		summarize: { head: 200, tail: 200 },
		failure: { head: 50, tail: 50 },
		counters: [
			{ name: "error", pattern: "error", flags: "i" },
			{ name: "warning", pattern: "warning", flags: "i" },
		],
	},
]

/**
 * Content-driven rules (content-driven rules (tests/search/generic families), but
 * keyed on OUTPUT CONTENT rather than argv/toolName — flowctx's tool results carry
 * no tool name, so argv matching is unusable). `contentMatch` is a regex tested
 * against the whole output; the first matching rule wins, generic/fallback last.
 */
export interface ContentCliRule extends CliRule {
	/** Whole-output regex; the rule is chosen when this matches. */
	contentMatch?: { pattern: string; flags?: string }
}

export const CONTENT_CLI_RULES: ContentCliRule[] = [
	{
		// Test runners (pytest/jest/vitest/go test/cargo test/…): keep failures + final summary.
		id: "content/test-results",
		match: {},
		contentMatch: {
			pattern:
				"(^|\\n)(={3,}.*(passed|failed|error).*={3,}|FAIL(ED)?\\b|PASS(ED)?\\b|\\d+ (passed|failed)|test result:|Tests:\\s|=== RUN|--- FAIL|ok\\s+\\S+\\s+[\\d.]+s)",
			flags: "i",
		},
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		filters: {
			skipPatterns: [
				"^platform .+",
				"^rootdir: ",
				"^plugins: ",
				"^collecting ",
				"^collected \\d+ item",
				"^\\s*$",
			],
			keepPatterns: [
				"={3,}.*(failed|passed|error).*={3,}",
				"^_{2,}.+_{2,}$",
				"^FAILED ",
				"^ERROR ",
				"^E\\s+",
				"AssertionError|Error:|panic:|thread '.*' panicked",
				"(FAILED|ERROR|FAIL)\\b",
				"^>\\s+",
				"\\d+ (passed|failed|error|skipped)",
				"test result:",
				"--- FAIL|^ok\\s",
			],
		},
		counters: [
			{ name: "failed", pattern: "(^|\\s)(FAILED|FAIL)\\b", flags: "i" },
			{ name: "passed", pattern: "(^|\\s)(PASSED|PASS|ok)\\b", flags: "i" },
		],
		summarize: { head: 10, tail: 12 },
		failure: { head: 16, tail: 18 },
	},
	{
		// grep/ripgrep/git-grep: keep the matching `path:line:` locator lines.
		id: "content/search",
		match: {},
		contentMatch: { pattern: "(^|\\n).+?:\\d+[:-].", flags: "" },
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		filters: {
			keepPatterns: [
				"^.+?:\\d+[:-].",
				"error|warning|binary file|permission denied|no such file",
				"^\\d+ match(es)?$",
			],
		},
		counters: [{ name: "match", pattern: "^.+?:\\d+[:-]." }],
		summarize: { head: 14, tail: 8 },
		failure: { head: 16, tail: 16 },
	},
	{
		// Generic noisy multi-line output: dedupe + head/tail window.
		id: "generic/fallback",
		match: {},
		transforms: { stripAnsi: true, dedupeAdjacent: true, trimEmptyEdges: true },
		summarize: { head: 40, tail: 20 },
		failure: { head: 60, tail: 40 },
	},
]

/** Pick a content-driven rule by output shape. generic/fallback is last resort. */
export function matchRuleByContent(text: string): ContentCliRule | null {
	for (const rule of CONTENT_CLI_RULES) {
		if (rule.id === "generic/fallback") continue
		const cm = rule.contentMatch
		if (cm && new RegExp(cm.pattern, reFlags(cm.flags) || undefined).test(text)) return rule
	}
	return CONTENT_CLI_RULES.find((r) => r.id === "generic/fallback") ?? null
}

function ruleMatches(rule: CliRule, argv: string[]): boolean {
	const m = rule.match
	if (!m || (!m.argv0 && !m.argvIncludes)) return true // {} matches all (fallback)
	if (m.argv0 && !m.argv0.includes(argv[0] ?? "")) return false
	if (m.argvIncludes) {
		const anyGroup = m.argvIncludes.some((group) => group.every((tok) => argv.includes(tok)))
		if (!anyGroup) return false
	}
	return true
}

/** Pick the best matching rule (specific first, generic/fallback last). */
export function matchRule(rules: CliRule[], toolName: string | undefined): CliRule | null {
	const argv = (toolName ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
	const ordered = [...rules].sort((a, b) => {
		const af = a.id === "generic/fallback" ? 1 : 0
		const bf = b.id === "generic/fallback" ? 1 : 0
		return af - bf
	})
	for (const rule of ordered) if (ruleMatches(rule, argv)) return rule
	return null
}

/**
 * Reduce tool-result text with a rule. Returns null if no real reduction (the two
 * rejection guards). exitCode selects the success vs failure window.
 */
export function reduceWithRule(text: string, rule: CliRule, exitCode = 0): string | null {
	// 1. outputMatches short-circuit.
	if (rule.matchOutput) {
		for (const om of rule.matchOutput) {
			if (new RegExp(om.pattern, reFlags(om.flags) || undefined).test(text)) {
				return om.message
			}
		}
	}

	// 2. preprocess.
	let body = text
	if (rule.transforms?.stripAnsi) body = stripAnsi(body)
	let lines = body.split("\n")
	if (rule.transforms?.trimEmptyEdges) lines = trimEmptyEdges(lines)
	if (rule.transforms?.dedupeAdjacent) lines = dedupeAdjacent(lines)

	// 4. counters (computed before keep/skip narrowing).
	const facts: string[] = []
	for (const c of rule.counters ?? []) {
		const n = countPattern(lines, c.pattern, c.flags)
		if (n > 0) facts.push(`${c.name}: ${n}`)
	}

	// 3. skip then keep.
	if (rule.filters?.skipPatterns?.length) {
		const skip = rule.filters.skipPatterns.map((p) => new RegExp(p))
		lines = lines.filter((l) => !skip.some((re) => re.test(l)))
	}
	if (rule.filters?.keepPatterns?.length) {
		const keep = rule.filters.keepPatterns.map((p) => new RegExp(p))
		const kept = lines.filter((l) => keep.some((re) => re.test(l)))
		if (kept.length > 0) lines = kept
	}

	// 5. window.
	const win = exitCode !== 0 && rule.failure ? rule.failure : rule.summarize
	lines = headTail(lines, win.head, win.tail)

	const header = facts.length ? `${facts.join("; ")}\n` : ""
	const inline = `${header}${lines.join("\n")}`

	// rejection guards: identical lines, or not actually shorter.
	if (inline.split("\n").join("\n") === text.split("\n").join("\n")) return null
	if (inline.length >= text.length) return null
	return inline
}
