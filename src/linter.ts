#!/usr/bin/env node
// Lints a plain text file that lists one version per line - the kind of
// file a release process might maintain by hand (a VERSIONS file, a tag
// log exported from git, a column pulled out of a changelog). Blank lines
// and lines starting with '#' are ignored so the file can carry comments.

import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, parseSemver, type SemverParts } from './semver.js'

export interface Finding {
  line: number
  column: number
  length: number
  severity: 'error' | 'warning'
  message: string
  rule: string
}

export function lintText(text: string): Finding[] {
  const findings: Finding[] = []
  const seen = new Map<string, number>()
  const lines = text.split(/\r\n|\r|\n/)
  let previous: { value: SemverParts; text: string; line: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const lineNo = i + 1
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const leadingWs = rawLine.length - rawLine.trimStart().length
    const result = parseSemver(trimmed)

    for (const issue of result.issues) {
      findings.push({
        line: lineNo,
        column: leadingWs + issue.start + 1,
        length: Math.max(1, issue.end - issue.start),
        severity: issue.severity,
        message: issue.message,
        rule: issue.rule,
      })
    }

    if (result.ok && result.value) {
      const firstLine = seen.get(trimmed)
      if (firstLine !== undefined) {
        findings.push({
          line: lineNo,
          column: leadingWs + 1,
          length: trimmed.length,
          severity: 'warning',
          message: `duplicate of the version on line ${firstLine}`,
          rule: 'duplicate-version',
        })
      } else {
        seen.set(trimmed, lineNo)
      }

      // Skip the comparison when the line is an exact repeat of the one
      // before it - that case is already covered by duplicate-version, and
      // reporting both would just be noise about the same two lines.
      if (previous && previous.text !== trimmed && compareSemver(result.value, previous.value) <= 0) {
        findings.push({
          line: lineNo,
          column: leadingWs + 1,
          length: trimmed.length,
          severity: 'warning',
          message: `version does not increase over the version on line ${previous.line} ('${previous.text}')`,
          rule: 'non-increasing-version',
        })
      }

      previous = { value: result.value, text: trimmed, line: lineNo }
    }
  }

  return findings
}

export interface FixResult {
  fixed: string
  // Number of versions actually changed - lines for lintText's input,
  // or 0/1 for lintPackageJson's, since there's only one version field.
  fixedCount: number
}

// Applies every issue that carries a `fix` (currently just the two
// leading-zero rules) to a single version string. Issues without a fix are
// left alone, so a version with both a fixable and an unfixable problem
// still comes back partially corrected rather than untouched.
function fixVersionString(input: string): { fixed: string; changed: boolean } {
  const fixable = parseSemver(input).issues.filter((issue) => issue.fix !== undefined)
  if (fixable.length === 0) return { fixed: input, changed: false }

  // Apply from the rightmost offset first so earlier splices don't shift
  // the start/end positions of the ones still to come.
  const sorted = [...fixable].sort((a, b) => b.start - a.start)
  let fixed = input
  for (const issue of sorted) {
    fixed = fixed.slice(0, issue.start) + issue.fix + fixed.slice(issue.end)
  }
  return { fixed, changed: true }
}

// Fixes every line of a version-list file the same way lintText reads it.
// Mixed line endings are normalized to whichever one appears first in the
// file, since there's no single "fixed" line ending to preserve otherwise.
export function fixText(text: string): FixResult {
  const ending = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n'
  const lines = text.split(/\r\n|\r|\n/)
  let fixedCount = 0

  const outLines = lines.map((rawLine) => {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return rawLine

    const leading = rawLine.slice(0, rawLine.length - rawLine.trimStart().length)
    const trailing = rawLine.slice(rawLine.trimEnd().length)
    const { fixed, changed } = fixVersionString(trimmed)
    if (!changed) return rawLine

    fixedCount++
    return leading + fixed + trailing
  })

  return { fixed: outLines.join(ending), fixedCount }
}

// Fixes the "version" field of a package.json in place, leaving the rest
// of the file - formatting, key order, other fields - untouched.
export function fixPackageJson(text: string): FixResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { fixed: text, fixedCount: 0 }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { fixed: text, fixedCount: 0 }
  }

  const version = (parsed as Record<string, unknown>).version
  if (typeof version !== 'string') {
    return { fixed: text, fixedCount: 0 }
  }

  const { fixed: fixedVersion, changed } = fixVersionString(version)
  if (!changed) return { fixed: text, fixedCount: 0 }

  const match = VERSION_FIELD.exec(text)
  if (!match) return { fixed: text, fixedCount: 0 }

  const valueStart = match.index + match[0].length - 1 - match[1].length
  const fixed = text.slice(0, valueStart) + fixedVersion + text.slice(valueStart + match[1].length)
  return { fixed, fixedCount: 1 }
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

// Matches the "version" key of a package.json anywhere it appears at the
// top of the object (npm always keeps it un-nested), capturing the raw
// text between the quotes so its offset in the file can be recovered
// without a full JSON parser. Semver version strings never need JSON
// escaping, so the raw and JSON.parse'd forms are the same in practice.
const VERSION_FIELD = /"version"\s*:\s*"((?:[^"\\]|\\.)*)"/

// Lints the "version" field of a package.json instead of a plain version
// list. There's exactly one version to check, so duplicate-version and
// non-increasing-version don't apply - those compare a line against
// others in the same file.
export function lintPackageJson(text: string): Finding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return [
      {
        line: 1,
        column: 1,
        length: 1,
        severity: 'error',
        message: `not valid JSON: ${(err as Error).message}`,
        rule: 'package-json-invalid',
      },
    ]
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [
      {
        line: 1,
        column: 1,
        length: 1,
        severity: 'error',
        message: 'top-level JSON value is not an object',
        rule: 'package-json-invalid',
      },
    ]
  }

  const version = (parsed as Record<string, unknown>).version
  if (version === undefined) {
    return [
      {
        line: 1,
        column: 1,
        length: 1,
        severity: 'error',
        message: "no 'version' field",
        rule: 'package-json-missing-version',
      },
    ]
  }

  if (typeof version !== 'string') {
    return [
      {
        line: 1,
        column: 1,
        length: 1,
        severity: 'error',
        message: "'version' field is not a string",
        rule: 'package-json-non-string-version',
      },
    ]
  }

  const match = VERSION_FIELD.exec(text)
  // match[0] ends with the closing quote right after the raw capture, so
  // its start is recoverable by walking back from there - no need to
  // re-search for the quote and risk matching an earlier one.
  const valueStart = match ? match.index + match[0].length - 1 - match[1].length : 0
  const { line, column } = offsetToLineColumn(text, valueStart)

  const result = parseSemver(version)
  return result.issues.map((issue) => ({
    line,
    column: column + issue.start,
    length: Math.max(1, issue.end - issue.start),
    severity: issue.severity,
    message: issue.message,
    rule: issue.rule,
  }))
}

export function formatFinding(path: string, finding: Finding): string {
  return `${path}:${finding.line}:${finding.column}: ${finding.severity}: ${finding.message} [${finding.rule}]`
}

// Kept separate from main() so the output shape is unit-testable without
// going through argv parsing or file I/O.
export function findingsToJson(path: string, findings: Finding[]): string {
  return JSON.stringify(
    findings.map((finding) => ({ path, ...finding })),
    null,
    2,
  )
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const jsonOutput = args.includes('--json')
  const fix = args.includes('--fix')
  const path = args.find((arg) => arg !== '--json' && arg !== '--fix')
  if (!path) {
    console.error('usage: semver-lint [--json] [--fix] <file>')
    process.exitCode = 1
    return
  }

  const isPackageJson = basename(path) === 'package.json'
  let text = await readFile(path, 'utf8')

  if (fix) {
    const result = isPackageJson ? fixPackageJson(text) : fixText(text)
    if (result.fixedCount > 0) {
      await writeFile(path, result.fixed, 'utf8')
      text = result.fixed
      const noun = isPackageJson ? 'issue' : 'line'
      console.error(`fixed ${result.fixedCount} ${noun}${result.fixedCount === 1 ? '' : 's'} in ${path}`)
    } else {
      console.error(`no automatic fixes available in ${path}`)
    }
  }

  const findings = isPackageJson ? lintPackageJson(text) : lintText(text)

  if (jsonOutput) {
    console.log(findingsToJson(path, findings))
  } else {
    for (const finding of findings) {
      console.log(formatFinding(path, finding))
    }
  }

  const errorCount = findings.filter((finding) => finding.severity === 'error').length
  if (errorCount > 0) {
    process.exitCode = 1
  }
}

// When installed from npm, argv[1] is the symlink in node_modules/.bin, not
// this file, and it may contain characters that file:// URLs percent-encode.
// Comparing resolved real paths handles both; a plain URL comparison would
// make the installed bin silently do nothing.
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((err: Error) => {
    console.error(`semver-lint: ${err.message}`)
    process.exitCode = 2
  })
}
