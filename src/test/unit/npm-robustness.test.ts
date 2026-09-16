import { describe, expect, it } from 'vitest'
import { parse, stringify, type Diagnostic } from '../../main/ts/index.ts'
import { LockfileError } from '../../main/ts/api/errors.ts'

// Robustness gaps from the 1828-file real-world `package-lock.json` sweep
// (tmp/npm-corpus). Both classes escaped as RAW `TypeError`s out of internal
// code — no code, no subject, no actionable message for a caller embedding the
// library. Minimal repros only; the fixture-backed regressions reduced from the
// actual offending locks live in interop/real-world/npm-robustness.test.ts.

const SRI = 'sha1-w7M6te42DYbg5ijwRorn7yfWVN8='

const collect = (input: string, format: 'npm-1' | 'npm-2' | 'npm-3') => {
  const diagnostics: Diagnostic[] = []
  const graph = parse(input, format, { onDiagnostic: d => { diagnostics.push(d) } })
  return { diagnostics, graph }
}

// `"resolved": false` is npm 5/6's own marker for "no resolution URL known" —
// it is written for the bundled dependencies of an optional package (the
// `fsevents` subtree is the classic carrier). 10 of the 1828 corpus locks carry
// it; every one crashed with `raw.startsWith is not a function`.
const npm1WithResolved = (resolved: string): string => `{
  "name": "repro",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "ansi-regex": {
      "version": "2.1.1",
      "resolved": ${resolved},
      "integrity": "${SRI}",
      "dev": true
    }
  }
}`

// npm accepts BOTH spellings of the root manifest's `workspaces` field and
// copies whichever it finds into `packages[""]`. 6 corpus locks carry the
// object form; every one crashed with `rootEntry.workspaces.slice is not a
// function`.
const npm2WithWorkspaces = (workspaces: string): string => `{
  "name": "repro",
  "lockfileVersion": 2,
  "requires": true,
  "packages": {
    "": {
      "name": "repro",
      "workspaces": ${workspaces}
    },
    "a": {
      "name": "a",
      "version": "1.0.0"
    },
    "node_modules/a": {
      "resolved": "a",
      "link": true
    }
  },
  "dependencies": {
    "a": {
      "version": "file:a"
    }
  }
}`

describe('parse', () => {
  it('treats an npm-1 `"resolved": false` entry as carrying no resolution instead of throwing', () => {
    const { graph } = collect(npm1WithResolved('false'), 'npm-1')
    const id = graph.byName('ansi-regex')[0]!
    expect(graph.getNode(id)).toBeDefined()
    expect(graph.tarballOf(id)?.nativeResolution).toBeUndefined()
    expect(graph.tarballOf(id)?.resolution).toEqual({ kind: 'registry' })
    // The integrity beside the dropped `resolved` must survive.
    expect(graph.tarballOf(id)?.integrity).toBeDefined()
  })

  it('names the offending npm-1 entry in a diagnostic when `resolved` is neither a string nor false', () => {
    const { diagnostics, graph } = collect(npm1WithResolved('42'), 'npm-1')
    const id = graph.byName('ansi-regex')[0]!
    expect(graph.getNode(id)).toBeDefined()
    const bad = diagnostics.filter(d => d.code === 'NPM_BAD_ENTRY')
    expect(bad).toHaveLength(1)
    expect(bad[0]!.subject).toBeDefined()
    expect(bad[0]!.subject).not.toBe('')
    expect(bad[0]!.message).toContain('ansi-regex')
    expect(bad[0]!.message).toContain('resolved')
  })

  it('does not let a non-string npm-1 `resolved` escape as a raw TypeError', () => {
    for (const shape of ['false', '42', 'true', '{"url":"x"}', '["x"]']) {
      try {
        parse(npm1WithResolved(shape), 'npm-1')
      } catch (error) {
        expect(error).toBeInstanceOf(LockfileError)
      }
    }
  })

  it('accepts the object form of the root `workspaces` field', () => {
    const { graph } = collect(npm2WithWorkspaces('{ "packages": ["a"] }'), 'npm-2')
    expect(graph.byName('a')[0]).toBeDefined()
  })

  it('names the root subject in a diagnostic when `workspaces` is neither an array nor an object', () => {
    const { diagnostics } = collect(npm2WithWorkspaces('"packages/*"'), 'npm-2')
    const bad = diagnostics.filter(d => d.code === 'NPM_BAD_ROOT_WORKSPACES')
    expect(bad).toHaveLength(1)
    expect(bad[0]!.subject).toBe('repro')
    expect(bad[0]!.subject).not.toBe('')
    expect(bad[0]!.message).toContain('workspaces')
  })

  it('does not let a malformed root `workspaces` escape as a raw TypeError', () => {
    for (const shape of ['{ "packages": ["a"] }', '"packages/*"', '42', 'true', 'null']) {
      try {
        parse(npm2WithWorkspaces(shape), 'npm-2')
      } catch (error) {
        expect(error).toBeInstanceOf(LockfileError)
      }
    }
  })
})

describe('stringify', () => {
  it('re-emits the object form of the root `workspaces` field verbatim', () => {
    const graph = parse(npm2WithWorkspaces('{ "packages": ["a"], "nohoist": ["b"] }'), 'npm-2')
    const out = JSON.parse(stringify(graph, 'npm-2')) as {
      packages: Record<string, { workspaces?: unknown }>
    }
    expect(out.packages['']!.workspaces).toEqual({ packages: ['a'], nohoist: ['b'] })
  })

  it('re-emits the array form of the root `workspaces` field unchanged', () => {
    const graph = parse(npm2WithWorkspaces('["a"]'), 'npm-2')
    const out = JSON.parse(stringify(graph, 'npm-2')) as {
      packages: Record<string, { workspaces?: unknown }>
    }
    expect(out.packages['']!.workspaces).toEqual(['a'])
  })
})
