// Structured, content-aware compression — ported from flowctx.
// Deterministic, no LLM. Lossy views; byte-exact reversibility is the caller's
// job (store.ts stores the original by hash → flowctx_retrieve returns it).

import { exploreStructuredData, exploreCode } from './vendor/structural-explorers.ts'
import { compactWholeJsonText, compactGitDiff, compactSearchLines } from './vendor/json-compress.ts'
import { matchRuleByContent, reduceWithRule } from './vendor/cli-rules.ts'

export type ContentType = 'json' | 'code' | 'log' | 'diff' | 'search' | 'test' | 'cli-output' | 'text'

export interface StructuredResult {
  text: string | null
  contentType: ContentType
}

const CODE_HINT_RE =
  /^\s*(import |export |from |def |class |func |function |public |private |const |let |var |#include|package )/m
const FENCE_RE = /```[\s\S]*```/
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|kt|swift)\b/
const DIFF_RE = /^diff --git |^@@ .* @@|^@@ /m
const SEARCH_LINE_RE = /^.+?:\d+[:-]./m
const TEST_RE = /(={3,}.*(passed|failed|error).*={3,}|^FAILED |^ok\s+\S+\s+[\d.]+s|\d+ (passed|failed)|test result:|^--- FAIL)/im
const LOG_RE = /^\s*(\d{4}-\d{2}-\d{2}|\[\d|INFO|WARN|ERROR|DEBUG)/m
const LARGE_JSON_ARRAY_THRESHOLD = 20

function lineHitRatio(text: string, re: RegExp): number {
  const lines = text.split('\n')
  if (lines.length === 0) return 0
  const per = new RegExp(re.source, re.flags.replace('m', ''))
  let hits = 0
  for (const l of lines) if (per.test(l)) hits++
  return hits / lines.length
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

export function detectContentType(text: string, toolName?: string): ContentType {
  const t = text.trimStart()
  if ((t.startsWith('{') || t.startsWith('[')) && tryParseJson(text) !== undefined) return 'json'
  if (DIFF_RE.test(text)) return 'diff'
  const name = (toolName ?? '').toLowerCase()
  if (CODE_EXT_RE.test(name)) return 'code'
  if (CODE_HINT_RE.test(text) && !FENCE_RE.test(text)) {
    const codeLines = text.split('\n').filter((l) => CODE_HINT_RE.test(l)).length
    if (codeLines >= 2) return 'code'
  }
  const lineCount = text.split('\n').length
  if (TEST_RE.test(text)) return 'test'
  if (lineCount >= 5 && lineHitRatio(text, SEARCH_LINE_RE) >= 0.5) return 'search'
  if (LOG_RE.test(text) && lineCount >= 20) return 'log'
  if (lineCount >= 8 && text.includes('\n')) return 'cli-output'
  return 'text'
}

export function projectJson(text: string): string | null {
  const parsed = tryParseJson(text)
  if (parsed === undefined) return null
  if (Array.isArray(parsed) && parsed.length >= LARGE_JSON_ARRAY_THRESHOLD) {
    return exploreStructuredData(text, 'application/json', 'payload.json')
  }
  const minified = compactWholeJsonText(text, Math.max(1200, Math.floor(text.length * 0.6)))
  if (minified && minified.length < text.length) return minified
  return exploreStructuredData(text, 'application/json', 'payload.json')
}

export function projectCode(text: string, toolName?: string): string | null {
  if (text.split('\n').length < 8) return null
  return exploreCode(text, toolName)
}

export function projectDiff(text: string): string | null {
  if (!DIFF_RE.test(text)) return null
  const out = compactGitDiff(text)
  return out.length < text.length ? out : null
}

export function projectCli(text: string, _toolName?: string, exitCode = 0): string | null {
  const rule = matchRuleByContent(text)
  if (!rule) return null
  return reduceWithRule(text, rule, exitCode)
}

export function projectSearch(text: string): string | null {
  if (text.split('\n').length < 5) return null
  const out = compactSearchLines(text)
  return out.length < text.length ? out : null
}

export function projectLog(text: string): string | null {
  const lines = text.split('\n')
  if (lines.length < 20) return null
  const out: string[] = []
  let prev: string | null = null
  let run = 0
  const flush = () => {
    if (prev === null) return
    out.push(run > 1 ? `${prev}  (×${run})` : prev)
  }
  for (const line of lines) {
    const norm = line.replace(/\d+/g, '#')
    if (norm === prev) {
      run++
    } else {
      flush()
      prev = norm
      run = 1
    }
  }
  flush()
  return `// log collapsed (adjacent duplicates merged; full log via flowctx_retrieve)\n${out.join('\n')}`
}

function sameLines(a: string, b: string): boolean {
  return a.split('\n').join('\n') === b.split('\n').join('\n')
}

export function compressStructured(text: string, toolName?: string, exitCode = 0): StructuredResult {
  const contentType = detectContentType(text, toolName)
  let candidate: string | null = null
  switch (contentType) {
    case 'json': candidate = projectJson(text); break
    case 'diff': candidate = projectDiff(text); break
    case 'code': candidate = projectCode(text, toolName); break
    case 'log': candidate = projectLog(text); break
    case 'search': candidate = projectSearch(text); break
    case 'test': candidate = projectCli(text, toolName, exitCode); break
    case 'cli-output': candidate = projectCli(text, toolName, exitCode); break
    default: candidate = null
  }
  if (candidate === null) return { text: null, contentType }
  if (sameLines(candidate, text) || candidate.length >= text.length) return { text: null, contentType }
  return { text: candidate, contentType }
}
