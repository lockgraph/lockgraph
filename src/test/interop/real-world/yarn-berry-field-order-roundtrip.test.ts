// Oracle for #117 (yarn-berry entry field-order).
//
// Real-world yarn.lock files in src/test/resources/fixtures/real-world/** ARE
// genuine `yarn install` output — i.e. ground truth for yarn's exact on-disk
// byte layout, including the per-entry field ORDER. This test asserts, for every
// real-world berry lock, that the per-entry field-key SEQUENCE emitted by
// `stringify(parse(x))` matches the on-disk sequence in `x` (the #117 contract),
// and — for locks with no unrelated fidelity nit — that the FULL file is
// byte-identical to `x`.
//
// It is deliberately NON-circular: it never regenerates a fixture through our
// own emit and never compares against a synthetic lockfiles/ fixture — the
// assertion is against the unmodified on-disk yarn output.
//
// The historical bug: our emitter ordered the trailing entry fields
// `bin, linkType, languageName, conditions, checksum`, whereas yarn writes
// `bin, checksum, conditions, languageName, linkType` (checksum before
// languageName/linkType; conditions between checksum and languageName). That
// broke byte-fidelity — and `yarn install --immutable` — on EVERY berry entry.
// Before the fix, 0/16 corpus berry locks round-tripped; the field-order
// assertion below fails loudly if it regresses.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { check } from '../../../main/ts/index.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import type { FormatId } from '../_types.ts'
import { REAL_WORLD_FIXTURES_ROOT } from './_probe.ts'

const BERRY_FORMATS: FormatId[] = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
]

// Locks that cannot reach FULL byte-identity because of a KNOWN, UNRELATED nit
// (not field-order — verified by the field-order assertion still passing). These
// are tracked here so the #117 oracle isn't blocked by orthogonal bugs; each has
// its own follow-up. The field-ORDER check still runs for them.
//
// EMPTY (#119): every real-world berry lock now reaches FULL byte-identity. The
// last two nits are fixed — GitHub-shorthand dep ranges (`pem: dexus/pem`,
// `buffer: "mischnic/buffer#…"`) emit VERBATIM instead of gaining a synthesised
// `npm:` prefix (parcel, yarnpkg-berry), and a very long compound entry key
// (> 1024 quoted chars) emits in yarn's explicit-key `? <key>\n:` form (highlight).
// Add a lock here ONLY for a genuinely NEW orthogonal nit — never to force-pass.
const KNOWN_NON_BYTE_IDENTICAL: Record<string, string> = {}

type BerryLock = { repo: string; format: FormatId; source: string }

function detectBerry(source: string): FormatId | undefined {
  const matches = BERRY_FORMATS.filter(f => check(f, source))
  return matches.length === 1 ? matches[0] : undefined
}

function loadRealWorldBerryLocks(): BerryLock[] {
  const out: BerryLock[] = []
  const repos = readdirSync(REAL_WORLD_FIXTURES_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
  for (const repo of repos) {
    const lockPath = resolve(REAL_WORLD_FIXTURES_ROOT, repo, 'yarn.lock')
    if (!existsSync(lockPath)) continue
    const source = readFileSync(lockPath, 'utf8')
    const format = detectBerry(source)
    if (format === undefined) continue // yarn-classic v1 or non-yarn — skip
    out.push({ repo, format, source })
  }
  return out
}

// Per-entry field-key sequence from RAW berry text: a top-level entry header is a
// line at col 0 ending `:` (skip `__metadata` and the `? … :` explicit-key
// continuation lines); its fields are exactly-2-space-indented `key:` lines. The
// result is an ordered list of (entryKeyLine, [field,…]) pairs — exactly the data
// #117 is about.
function fieldSequencesByEntry(text: string): Array<{ header: string; fields: string[] }> {
  const lines = text.split('\n')
  const entries: Array<{ header: string; fields: string[] }> = []
  let cur: { header: string; fields: string[] } | null = null
  let inExplicitKey = false
  for (const line of lines) {
    if (line.length === 0) continue
    // yarn wraps very long compound keys as `?\n  "<key>"\n:` — the `?`/`:`
    // delimiters and the indented key body are not entry fields; skip them but
    // treat the block as a header boundary.
    if (line === '?' || line.startsWith('? ')) { inExplicitKey = true; cur = { header: line, fields: [] }; entries.push(cur); continue }
    if (inExplicitKey) {
      if (line === ':' || line.startsWith(': ')) { inExplicitKey = false }
      continue
    }
    if (line[0] !== ' ' && line[0] !== '\t' && line.endsWith(':')) {
      if (line.startsWith('__metadata')) { cur = null; continue }
      cur = { header: line, fields: [] }
      entries.push(cur)
      continue
    }
    if (cur === null) continue
    const m = /^  ([A-Za-z][A-Za-z0-9]*):(?:\s|$)/.exec(line)
    if (m) cur.fields.push(m[1]!)
  }
  return entries.filter(e => e.fields.length > 0)
}

const berryLocks = loadRealWorldBerryLocks()

describe('real-world yarn-berry byte round-trip (field order — #117)', () => {
  it('discovers the berry corpus across multiple versions', () => {
    expect(berryLocks.length).toBeGreaterThanOrEqual(10)
    expect(new Set(berryLocks.map(l => l.format)).size).toBeGreaterThanOrEqual(4)
  })

  for (const lock of berryLocks) {
    const knownNit = KNOWN_NON_BYTE_IDENTICAL[lock.repo]
    const label = `${lock.repo} (${lock.format})`

    it(`${label}: per-entry field ORDER matches yarn${knownNit ? ' [byte-id blocked: ' + knownNit + ']' : ''}`, () => {
      const graph = parseFormat(lock.format, lock.source)
      // No cacheKey override: stringify reuses each lock's own
      // __metadata.cacheKey (captured on parse), preserving byte identity.
      const { lockfile } = stringifyFormat(lock.format, graph)

      // #117 contract: every emitted entry's field-key SEQUENCE must equal the
      // on-disk sequence. Both files iterate entries in the same canonical
      // (cmpStr) order, so compare positionally — this is robust to a header
      // rendered differently (e.g. yarn's `? <long-key> :` wrapping vs a single
      // quoted line), which is an orthogonal key-formatting nit, not field-order.
      const srcSeq = fieldSequencesByEntry(lock.source).map(e => e.fields)
      const emitSeq = fieldSequencesByEntry(lockfile).map(e => e.fields)
      expect(emitSeq.length).toBe(srcSeq.length)
      for (let i = 0; i < srcSeq.length; i++) {
        expect(emitSeq[i], `entry #${i} field order`).toEqual(srcSeq[i])
      }

      // Full byte-identity is the strong oracle; assert it for every lock without
      // an unrelated known nit. (Most berry locks reach it after the #117 fix.)
      if (knownNit === undefined) {
        expect(lockfile).toBe(lock.source)
      }
    })
  }
})
