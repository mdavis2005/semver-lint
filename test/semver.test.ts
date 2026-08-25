import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver } from '../src/semver.js'
import { findingsToJson, lintText } from '../src/linter.js'

function precedenceOf(version: string) {
  const result = parseSemver(version)
  assert.ok(result.ok && result.value, `expected '${version}' to parse cleanly`)
  return result.value!
}

interface Case {
  name: string
  input: string
  ok: boolean
  // rule ids that must appear among the issues, in any order
  rules?: string[]
}

const cases: Case[] = [
  { name: 'plain release', input: '1.2.3', ok: true },
  { name: 'all zero', input: '0.0.0', ok: true },
  { name: 'major beyond Number.MAX_SAFE_INTEGER', input: '99999999999999999999.0.0', ok: true },
  { name: 'simple pre-release', input: '1.2.3-alpha', ok: true },
  { name: 'dotted pre-release', input: '1.2.3-alpha.1', ok: true },
  { name: 'numeric pre-release identifiers', input: '1.2.3-0.3.7', ok: true },
  { name: 'mixed pre-release identifiers', input: '1.2.3-x.7.z.92', ok: true },
  { name: 'build metadata', input: '1.2.3+20130313144700', ok: true },
  { name: 'pre-release with build metadata', input: '1.2.3-beta+exp.sha.5114f85', ok: true },
  { name: 'build metadata allows a leading zero', input: '1.2.3-alpha+001', ok: true },
  { name: "leading 'v' is a warning, not an error", input: 'v1.2.3', ok: true, rules: ['v-prefix'] },

  { name: 'missing patch', input: '1.2', ok: false, rules: ['core-shape'] },
  { name: 'too many core fields', input: '1.2.3.4', ok: false, rules: ['core-shape'] },
  { name: 'trailing dot leaves patch empty', input: '1.2.', ok: false, rules: ['core-missing'] },
  { name: 'leading zero in major', input: '01.2.3', ok: false, rules: ['core-leading-zero'] },
  { name: 'leading zero in minor', input: '1.02.3', ok: false, rules: ['core-leading-zero'] },
  { name: 'leading zero in patch', input: '1.2.03', ok: false, rules: ['core-leading-zero'] },
  { name: 'non-numeric core field', input: '1.2.3 extra', ok: false, rules: ['core-non-numeric'] },
  { name: 'trailing dash with nothing after', input: '1.2.3-', ok: false, rules: ['prerelease-empty-id'] },
  { name: 'trailing plus with nothing after', input: '1.2.3+', ok: false, rules: ['build-empty-id'] },
  { name: 'leading zero in numeric pre-release id', input: '1.2.3-01', ok: false, rules: ['prerelease-leading-zero'] },
  { name: 'empty pre-release identifier between dots', input: '1.2.3-alpha..1', ok: false, rules: ['prerelease-empty-id'] },
  { name: 'invalid character in pre-release', input: '1.2.3-alpha_beta', ok: false, rules: ['prerelease-invalid-char'] },
  { name: 'invalid character in build metadata', input: '1.2.3+build_meta', ok: false, rules: ['build-invalid-char'] },
  // The first '-' after stripping build metadata marks the start of the
  // pre-release section, even when it falls inside what looks like the
  // core version - so a dash right after a dot starves the core of a
  // patch field instead of becoming part of a pre-release identifier.
  { name: 'a dash right after a dot empties the patch field', input: '1.2.-3', ok: false, rules: ['core-missing'] },
  { name: 'completely empty string', input: '', ok: false, rules: ['core-shape'] },
]

test('parseSemver table-driven cases', () => {
  for (const testCase of cases) {
    const result = parseSemver(testCase.input)
    assert.equal(
      result.ok,
      testCase.ok,
      `${testCase.name}: expected ok=${testCase.ok}, got ok=${result.ok} (issues: ${JSON.stringify(result.issues)})`,
    )
    if (testCase.rules) {
      const foundRules = result.issues.map((issue) => issue.rule)
      for (const rule of testCase.rules) {
        assert.ok(
          foundRules.includes(rule),
          `${testCase.name}: expected rule '${rule}', found [${foundRules.join(', ')}]`,
        )
      }
    }
  }
})

test('lintText reports duplicate versions against the first occurrence', () => {
  const text = ['1.0.0', '1.1.0', '1.0.0', ''].join('\n')
  const findings = lintText(text)
  const duplicate = findings.find((finding) => finding.rule === 'duplicate-version')
  assert.ok(duplicate, 'expected a duplicate-version finding')
  assert.equal(duplicate?.line, 3)
  assert.equal(duplicate?.message, 'duplicate of the version on line 1')
})

test('lintText ignores blank lines and comments while keeping line numbers accurate', () => {
  const text = ['# releases', '', '1.0.0', '01.0.0', ''].join('\n')
  const findings = lintText(text)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 4)
  assert.equal(findings[0].rule, 'core-leading-zero')
})

test('lintText reports columns relative to leading whitespace and the v-prefix', () => {
  const findings = lintText('  v01.2.3')
  const leadingZero = findings.find((finding) => finding.rule === 'core-leading-zero')
  assert.ok(leadingZero)
  // two spaces, then 'v', so the major field starts at column 4 (1-based)
  assert.equal(leadingZero?.column, 4)
})

test('compareSemver orders versions per the semver.org 2.0.0 section 11 example', () => {
  // Straight from the spec: 1.0.0-alpha < 1.0.0-alpha.1 < ... < 1.0.0.
  const ascending = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '2.0.0',
    '2.1.0',
    '2.1.1',
  ].map(precedenceOf)

  for (let i = 1; i < ascending.length; i++) {
    assert.equal(compareSemver(ascending[i - 1], ascending[i]), -1, `expected index ${i - 1} < ${i}`)
    assert.equal(compareSemver(ascending[i], ascending[i - 1]), 1, `expected index ${i} > ${i - 1}`)
  }
})

test('compareSemver treats equal precedence as equal regardless of build metadata', () => {
  assert.equal(compareSemver(precedenceOf('1.2.3+build.1'), precedenceOf('1.2.3+build.2')), 0)
  assert.equal(compareSemver(precedenceOf('1.2.3-rc.1+a'), precedenceOf('1.2.3-rc.1+b')), 0)
})

test('lintText flags a version that does not increase over the line before it', () => {
  const text = ['1.2.0', '1.1.0', '1.1.0'].join('\n')
  const findings = lintText(text)
  const ordering = findings.filter((finding) => finding.rule === 'non-increasing-version')
  assert.equal(ordering.length, 1)
  assert.equal(ordering[0].line, 2)
  assert.match(ordering[0].message, /line 1/)
  // the exact repeat on line 3 is duplicate-version's job, not ordering's
  assert.ok(!findings.some((finding) => finding.rule === 'non-increasing-version' && finding.line === 3))
  assert.ok(findings.some((finding) => finding.rule === 'duplicate-version' && finding.line === 3))
})

test('lintText skips unparseable lines when finding the previous version to compare against', () => {
  const text = ['1.0.0', 'not-a-version', '2.0.0'].join('\n')
  const findings = lintText(text)
  assert.ok(!findings.some((finding) => finding.rule === 'non-increasing-version'))
})

test('findingsToJson embeds the path and preserves every finding field', () => {
  const findings = lintText(['1.02.0'].join('\n'))
  const parsed = JSON.parse(findingsToJson('VERSIONS', findings))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].path, 'VERSIONS')
  assert.equal(parsed[0].line, 1)
  assert.equal(parsed[0].rule, 'core-leading-zero')
  assert.equal(parsed[0].severity, 'error')
})

test('findingsToJson returns an empty array for a clean file', () => {
  const findings = lintText('1.0.0')
  assert.deepEqual(JSON.parse(findingsToJson('VERSIONS', findings)), [])
})
