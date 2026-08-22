// Lints a plain text file that lists one version per line - the kind of
// file a release process might maintain by hand (a VERSIONS file, a tag
// log exported from git, a column pulled out of a changelog). Blank lines
// and lines starting with '#' are ignored so the file can carry comments.

import { readFile } from 'node:fs/promises'
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

export function formatFinding(path: string, finding: Finding): string {
  return `${path}:${finding.line}:${finding.column}: ${finding.severity}: ${finding.message} [${finding.rule}]`
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: semver-lint <file>')
    process.exitCode = 1
    return
  }

  const text = await readFile(path, 'utf8')
  const findings = lintText(text)

  for (const finding of findings) {
    console.log(formatFinding(path, finding))
  }

  const errorCount = findings.filter((finding) => finding.severity === 'error').length
  if (errorCount > 0) {
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  main()
}
