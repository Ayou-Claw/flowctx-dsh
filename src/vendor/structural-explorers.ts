// Vendored from lossless-claw (MIT). Pure, dependency-free structured/code
// explorers that produce a compact deterministic summary with NO LLM call
// (exploreJson / exploreDelimited / exploreYaml / exploreXml / exploreStructuredData
// / exploreCode).

function normalizeTextForLine(text: string, maxLen: number): string {
	const compact = text.replace(/\s+/g, " ").trim()
	if (compact.length <= maxLen) return compact
	return `${compact.slice(0, maxLen)}...`
}

function uniqueOrdered(values: Iterable<string>): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value)
			out.push(value)
		}
	}
	return out
}

function collectFileNameExtension(fileName?: string): string | undefined {
	if (!fileName) return undefined
	const base = fileName.trim().split(/[\\/]/).pop() ?? ""
	const idx = base.lastIndexOf(".")
	if (idx <= 0 || idx === base.length - 1) return undefined
	const ext = base.slice(idx + 1).toLowerCase()
	if (!/^[a-z0-9]{1,10}$/.test(ext)) return undefined
	return ext
}

export function exploreJson(content: string): string {
	const parsed = JSON.parse(content) as unknown
	const describe = (value: unknown, depth = 0): string => {
		if (depth >= 2) return "..."
		if (Array.isArray(value)) {
			const sample = value.slice(0, 3).map((item) => describe(item, depth + 1))
			return `array(len=${value.length}${sample.length > 0 ? `, sample=[${sample.join(", ")}]` : ""})`
		}
		if (!value || typeof value !== "object") return typeof value
		const keys = Object.keys(value as Record<string, unknown>)
		const preview = keys.slice(0, 10).join(", ")
		return `object(keys=${keys.length}${preview ? `: ${preview}` : ""})`
	}
	const topLevel = Array.isArray(parsed) ? "array" : typeof parsed
	return [`Structured summary (JSON):`, `Top-level type: ${topLevel}.`, `Shape: ${describe(parsed)}.`].join(
		"\n",
	)
}

function parseDelimitedLine(line: string, delimiter: "," | "\t"): string[] {
	return line
		.split(delimiter)
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
}

export function exploreDelimited(content: string, delimiter: "," | "\t", kind: "CSV" | "TSV"): string {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	if (lines.length === 0) return `Structured summary (${kind}): no rows found.`
	const headers = parseDelimitedLine(lines[0], delimiter)
	const rowCount = Math.max(0, lines.length - 1)
	const firstData = lines[1] ? normalizeTextForLine(lines[1], 180) : "(no data rows)"
	return [
		`Structured summary (${kind}):`,
		`Rows: ${rowCount.toLocaleString("en-US")}.`,
		`Columns (${headers.length}): ${headers.join(", ") || "(none detected)"}.`,
		`First row sample: ${firstData}.`,
	].join("\n")
}

export function exploreYaml(content: string): string {
	const topLevelKeys = uniqueOrdered(
		content
			.split(/\r?\n/)
			.map((line) => {
				const match = line.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/)
				return match ? match[1] : ""
			})
			.filter((key) => key.length > 0),
	)
	return [
		"Structured summary (YAML):",
		`Top-level keys (${topLevelKeys.length}): ${topLevelKeys.slice(0, 30).join(", ") || "(none detected)"}.`,
	].join("\n")
}

export function exploreXml(content: string): string {
	const rootMatch = content.match(/<([A-Za-z0-9_:-]+)(\s|>)/)
	const rootTag = rootMatch?.[1] ?? "unknown"
	const childTags = uniqueOrdered(
		[...content.matchAll(/<([A-Za-z0-9_:-]+)(\s|>)/g)]
			.map((match) => match[1])
			.filter((tag) => tag !== rootTag)
			.slice(0, 30),
	)
	return [
		"Structured summary (XML):",
		`Root element: ${rootTag}.`,
		`Child elements seen: ${childTags.join(", ") || "(none detected)"}.`,
	].join("\n")
}

export function exploreCode(content: string, fileName?: string): string {
	const lines = content.split(/\r?\n/)
	const imports = uniqueOrdered(
		lines
			.filter((line) =>
				/^\s*(import\s+|from\s+\S+\s+import\s+|const\s+\w+\s*=\s*require\()/.test(line),
			)
			.map((line) => normalizeTextForLine(line, 180))
			.slice(0, 12),
	)
	const signatures = uniqueOrdered(
		lines
			.map((line) => line.trim())
			.filter((line) =>
				/^(export\s+)?(async\s+)?(function|class|interface|type|const\s+\w+\s*=\s*\(|def\s+\w+\(|struct\s+\w+)/.test(
					line,
				),
			)
			.map((line) => normalizeTextForLine(line, 200))
			.slice(0, 24),
	)
	return [
		`Code exploration summary${fileName ? ` (${fileName})` : ""}:`,
		`Lines: ${lines.length.toLocaleString("en-US")}.`,
		`Imports/dependencies (${imports.length}): ${imports.join(" | ") || "none detected"}.`,
		`Top-level definitions (${signatures.length}): ${signatures.join(" | ") || "none detected"}.`,
	].join("\n")
}

/** Route structured data by extension/mime to the matching explorer. */
export function exploreStructuredData(content: string, mimeType?: string, fileName?: string): string {
	const extension = collectFileNameExtension(fileName)
	const normalizedMime = mimeType?.trim().toLowerCase() ?? ""
	if (extension === "json" || normalizedMime.startsWith("application/json")) {
		try {
			return exploreJson(content)
		} catch {
			return "Structured summary (JSON): failed to parse as valid JSON."
		}
	}
	if (extension === "csv" || normalizedMime.startsWith("text/csv")) {
		return exploreDelimited(content, ",", "CSV")
	}
	if (extension === "tsv" || normalizedMime.startsWith("text/tab-separated-values")) {
		return exploreDelimited(content, "\t", "TSV")
	}
	if (
		extension === "xml" ||
		normalizedMime.startsWith("text/xml") ||
		normalizedMime.startsWith("application/xml")
	) {
		return exploreXml(content)
	}
	if (extension === "yaml" || extension === "yml" || normalizedMime.includes("yaml")) {
		return exploreYaml(content)
	}
	return [
		"Structured summary:",
		`Characters: ${content.length.toLocaleString("en-US")}.`,
		`Lines: ${content.split(/\r?\n/).length.toLocaleString("en-US")}.`,
	].join("\n")
}
