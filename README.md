# semver-lint

A linter for semantic version strings. It reads a text file with one
version per line and reports every place a line deviates from the
semver.org 2.0.0 grammar, with the line and column where the problem
starts.

I keep running into version lists that were typed by hand - a `VERSIONS`
file next to a release script, a column copied out of a changelog, a list
of git tags dumped to a file - and they accumulate small mistakes that
`git log` won't catch: a leading zero on a minor version, a stray dash
with nothing after it, a duplicate entry from a copy-paste. This checks
that list the same way a linter checks source code.

## Usage

Given a file `VERSIONS`:

```
# public releases
1.0.0
1.1.0
1.1.0
1.02.0
2.0.0-rc.1
2.0.0-
```

Running:

```
npm run build
node dist/src/linter.js VERSIONS
```

produces:

```
VERSIONS:4:2: warning: duplicate of the version on line 3 [duplicate-version]
VERSIONS:5:2: error: minor version has a leading zero: '02' [core-leading-zero]
VERSIONS:7:8: error: pre-release identifier is empty (check for a stray or trailing dot) [prerelease-empty-id]
```

The process exits with a non-zero status if any finding is an error,
which makes it usable as a pre-commit or CI check. Warnings never affect
the exit status.

Pass `--json` to get findings as a JSON array instead of the text format
above, for CI systems that want to parse the output rather than grep it:

```
node dist/src/linter.js --json VERSIONS
```

```json
[
  {
    "path": "VERSIONS",
    "line": 4,
    "column": 2,
    "length": 5,
    "severity": "warning",
    "message": "duplicate of the version on line 3",
    "rule": "duplicate-version"
  }
]
```

The exit status rule is the same either way - non-zero if any finding is
an error.

## Input format

- One version per line.
- Blank lines are ignored.
- Lines starting with `#` are treated as comments and ignored.
- Leading/trailing whitespace around a version is ignored for parsing but
  still counted when computing the column of a finding.

## Rules

| rule | severity | meaning |
| --- | --- | --- |
| `v-prefix` | warning | line starts with `v`/`V`, which is common but not part of the semver grammar |
| `core-shape` | error | not exactly three dot-separated fields before any `-` or `+` |
| `core-missing` | error | major, minor, or patch field is empty |
| `core-non-numeric` | error | major, minor, or patch field is not all digits |
| `core-leading-zero` | error | major, minor, or patch field has a leading zero (e.g. `01`) |
| `prerelease-empty-id` | error | empty pre-release identifier, e.g. `1.0.0-` or `1.0.0-a..b` |
| `prerelease-invalid-char` | error | pre-release identifier has a character outside `[0-9A-Za-z-]` |
| `prerelease-leading-zero` | error | numeric pre-release identifier has a leading zero |
| `build-empty-id` | error | empty build metadata identifier |
| `build-invalid-char` | error | build metadata identifier has a character outside `[0-9A-Za-z-]` |
| `duplicate-version` | warning | exact same version string already appeared earlier in the file |
| `non-increasing-version` | warning | version does not have a strictly greater precedence than the version on the line before it |

Build metadata identifiers are allowed to have leading zeros - the spec
never uses build metadata for precedence comparisons, so there is nothing
to warn about there.

`non-increasing-version` compares each line's precedence (per the ordering
rules in semver.org section 11) against the line before it, not against
the whole file - so a file can be in ascending order overall while a
single out-of-place line still gets flagged against its immediate
neighbor. Lines that don't parse are skipped when looking for the
"previous" version, and an exact repeat of the line before it is left to
`duplicate-version` instead of being flagged twice.

## Building and testing

There are no runtime dependencies. TypeScript is a dev dependency used
only to compile.

```
npm install
npm run build
npm test
```

`npm test` compiles then runs the test suite with Node's built-in test
runner (`node --test`), no test framework required.

## Library use

`src/semver.ts` exports `parseSemver(input: string)`, which parses a
single version string and returns every issue it found rather than
stopping at the first one. `src/linter.ts` exports `lintText(text: string)`
for running that parser over a whole file's worth of lines. Both are
plain functions with no I/O, so they're usable outside the CLI.
