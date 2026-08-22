// Parses a single version string against the semantic versioning grammar
// (semver.org 2.0.0) and collects every deviation instead of stopping at the
// first one, so a caller can report several problems on the same line.
//
// Major/minor/patch are kept as strings rather than numbers. Versions like
// "99999999999999999999.0.0" are legal under the spec but lose precision as
// a JS number, and nothing here actually needs to do arithmetic on them.

export type IssueSeverity = 'error' | 'warning'

export interface ParseIssue {
  rule: string
  severity: IssueSeverity
  message: string
  // Character offsets into the original input string, for callers that
  // want to point at the exact substring that triggered the issue.
  start: number
  end: number
}

export interface SemverParts {
  major: string
  minor: string
  patch: string
  prerelease: string[]
  build: string[]
}

export interface ParseResult {
  ok: boolean
  value: SemverParts | null
  issues: ParseIssue[]
}

const ALL_DIGITS = /^\d+$/
const IDENTIFIER_CHARS = /^[0-9A-Za-z-]+$/

interface Field {
  text: string
  start: number
}

function splitWithOffsets(text: string, base: number): Field[] {
  const parts = text.split('.')
  const fields: Field[] = []
  let pos = base
  for (const part of parts) {
    fields.push({ text: part, start: pos })
    pos += part.length + 1
  }
  return fields
}

function checkCoreField(field: Field, label: string, issues: ParseIssue[]): void {
  if (field.text === '') {
    issues.push({
      rule: 'core-missing',
      severity: 'error',
      message: `${label} version is missing`,
      start: field.start,
      end: field.start + 1,
    })
    return
  }

  if (!ALL_DIGITS.test(field.text)) {
    issues.push({
      rule: 'core-non-numeric',
      severity: 'error',
      message: `${label} version must be a non-negative integer, found '${field.text}'`,
      start: field.start,
      end: field.start + field.text.length,
    })
    return
  }

  if (field.text.length > 1 && field.text[0] === '0') {
    issues.push({
      rule: 'core-leading-zero',
      severity: 'error',
      message: `${label} version has a leading zero: '${field.text}'`,
      start: field.start,
      end: field.start + field.text.length,
    })
  }
}

function checkPrereleaseId(field: Field, issues: ParseIssue[]): void {
  if (field.text === '') {
    issues.push({
      rule: 'prerelease-empty-id',
      severity: 'error',
      message: 'pre-release identifier is empty (check for a stray or trailing dot)',
      start: field.start,
      end: field.start + 1,
    })
    return
  }

  if (!IDENTIFIER_CHARS.test(field.text)) {
    issues.push({
      rule: 'prerelease-invalid-char',
      severity: 'error',
      message: `pre-release identifier '${field.text}' may only contain ASCII letters, digits, and hyphens`,
      start: field.start,
      end: field.start + field.text.length,
    })
    return
  }

  if (ALL_DIGITS.test(field.text) && field.text.length > 1 && field.text[0] === '0') {
    issues.push({
      rule: 'prerelease-leading-zero',
      severity: 'error',
      message: `numeric pre-release identifier '${field.text}' has a leading zero`,
      start: field.start,
      end: field.start + field.text.length,
    })
  }
}

function checkBuildId(field: Field, issues: ParseIssue[]): void {
  if (field.text === '') {
    issues.push({
      rule: 'build-empty-id',
      severity: 'error',
      message: 'build metadata identifier is empty (check for a stray or trailing dot)',
      start: field.start,
      end: field.start + 1,
    })
    return
  }

  if (!IDENTIFIER_CHARS.test(field.text)) {
    issues.push({
      rule: 'build-invalid-char',
      severity: 'error',
      message: `build metadata identifier '${field.text}' may only contain ASCII letters, digits, and hyphens`,
      start: field.start,
      end: field.start + field.text.length,
    })
  }
  // Unlike pre-release identifiers, numeric build metadata identifiers are
  // allowed to have leading zeros: the spec never compares build metadata.
}

// Compares two numeric core fields (major/minor/patch) or numeric
// pre-release identifiers that have already passed validation, so neither
// has a leading zero (other than the single digit "0" itself). That means
// plain length-then-lexicographic comparison gives the right numeric
// ordering without needing BigInt for values beyond Number.MAX_SAFE_INTEGER.
function compareNumericField(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = ALL_DIGITS.test(a)
  const bNumeric = ALL_DIGITS.test(b)
  if (aNumeric && bNumeric) return compareNumericField(a, b)
  // Rule 11.4.1: numeric identifiers always have lower precedence than
  // alphanumeric identifiers.
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const cmp = compareIdentifier(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  // Rule 11.4.4: a larger set of pre-release fields has higher precedence
  // than a smaller set, once all shared fields compare equal.
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return 0
}

// Implements the precedence ordering from semver.org 2.0.0 section 11.
// Build metadata is intentionally ignored: the spec says it must not be
// used when determining precedence.
export function compareSemver(a: SemverParts, b: SemverParts): number {
  const core =
    compareNumericField(a.major, b.major) ||
    compareNumericField(a.minor, b.minor) ||
    compareNumericField(a.patch, b.patch)
  if (core !== 0) return core

  const aHasPrerelease = a.prerelease.length > 0
  const bHasPrerelease = b.prerelease.length > 0
  // Rule 11.3: a version with a pre-release has lower precedence than the
  // same core version without one.
  if (aHasPrerelease !== bHasPrerelease) return aHasPrerelease ? -1 : 1
  if (!aHasPrerelease) return 0

  return comparePrerelease(a.prerelease, b.prerelease)
}

export function parseSemver(input: string): ParseResult {
  const issues: ParseIssue[] = []
  let rest = input
  let offset = 0

  if (rest.length > 0 && (rest[0] === 'v' || rest[0] === 'V')) {
    issues.push({
      rule: 'v-prefix',
      severity: 'warning',
      message: "a leading 'v' is common in practice but is not part of the semantic versioning grammar",
      start: 0,
      end: 1,
    })
    rest = rest.slice(1)
    offset = 1
  }

  // Build metadata is introduced by the first '+'. Its own character set
  // never includes '+', so the first occurrence is unambiguous.
  let build: Field[] | null = null
  const plusIdx = rest.indexOf('+')
  if (plusIdx !== -1) {
    build = splitWithOffsets(rest.slice(plusIdx + 1), offset + plusIdx + 1)
    rest = rest.slice(0, plusIdx)
  }

  // Pre-release is introduced by the first '-' remaining after build
  // metadata is stripped. The numeric core fields never contain '-', so
  // this is also unambiguous, even though pre-release identifiers may
  // themselves contain further hyphens.
  let prerelease: Field[] | null = null
  const dashIdx = rest.indexOf('-')
  if (dashIdx !== -1) {
    prerelease = splitWithOffsets(rest.slice(dashIdx + 1), offset + dashIdx + 1)
    rest = rest.slice(0, dashIdx)
  }

  const core = splitWithOffsets(rest, offset)
  if (core.length !== 3) {
    issues.push({
      rule: 'core-shape',
      severity: 'error',
      message: `expected 3 dot-separated numeric fields (major.minor.patch), found ${core.length}`,
      start: offset,
      end: offset + rest.length,
    })
  } else {
    checkCoreField(core[0], 'major', issues)
    checkCoreField(core[1], 'minor', issues)
    checkCoreField(core[2], 'patch', issues)
  }

  if (prerelease) {
    for (const id of prerelease) checkPrereleaseId(id, issues)
  }

  if (build) {
    for (const id of build) checkBuildId(id, issues)
  }

  const hasError = issues.some((issue) => issue.severity === 'error')
  if (hasError) {
    return { ok: false, value: null, issues }
  }

  return {
    ok: true,
    value: {
      major: core[0].text,
      minor: core[1].text,
      patch: core[2].text,
      prerelease: prerelease ? prerelease.map((id) => id.text) : [],
      build: build ? build.map((id) => id.text) : [],
    },
    issues,
  }
}
