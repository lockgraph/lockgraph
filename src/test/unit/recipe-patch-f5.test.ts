// ADR-0014 §4.F5 — CRLF / BOM byte normalisation on patch file bytes
// before the F2 sha512 fingerprint. Tests cover (a) the primitive in
// isolation, (b) cross-platform F2 hash stability under CRLF rewrites,
// and (c) per-node `RECIPE_PATCH_NORMALISED` diagnostic emission across
// yarn-berry-v9 and pnpm-v9 adapters.

import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  canonicalHashOfBytes,
  normalizePatchBytes,
} from '../../main/ts/recipe/patch.ts'
import {
  patchNormalizedDiagnostic,
  emitPatchNormalized,
} from '../../main/ts/recipe/diagnostics.ts'
import { toTarballKey, type Diagnostic } from '../../main/ts/graph.ts'
import { parse } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureText = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')
const templateDir = (rel: string): string =>
  resolve(here, '../resources/fixtures/templates', rel)
const PATCH_FILE = '.yarn/patches/lodash-npm-4.17.21-6382451519.patch'

const LF_PATCH_BYTES = readFileSync(
  resolve(templateDir('patch-yarn'), PATCH_FILE),
)
const LF_PATCH_HASH = createHash('sha512').update(LF_PATCH_BYTES).digest('hex')
const patchedNodeId = (name: string, version: string, patch: string): string =>
  toTarballKey({ name, version, patch })

/** Re-encode every standalone LF as CRLF; idempotent on already-CRLF text. */
function toCRLF(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0x0A && (i === 0 || bytes[i - 1] !== 0x0D)) {
      out.push(0x0D, 0x0A)
    } else {
      out.push(b)
    }
  }
  return Uint8Array.from(out)
}

// === Primitive: normalizePatchBytes =========================================

describe('recipe/patch — normalizePatchBytes (F5 primitive)', () => {
  it('rewrites every CRLF pair to a single LF and reports normalised', () => {
    const input = new TextEncoder().encode('a\r\nb\r\nc\r\n')
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(true)
    expect(new TextDecoder().decode(bytes)).toBe('a\nb\nc\n')
  })

  it('reports normalised=false when input is already LF-only', () => {
    const input = new TextEncoder().encode('a\nb\nc\n')
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(false)
    // zero-copy fast path returns the same reference.
    expect(bytes).toBe(input)
  })

  it('preserves standalone CR (no CRLF pair) verbatim — F5 normalises the pair only', () => {
    const input = new TextEncoder().encode('a\rb\rc')
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(false)
    expect(bytes).toBe(input)
  })

  it('preserves a trailing newline byte-for-byte (F5 is line-ending equaliser, not trailing-byte rewrite)', () => {
    const withTrailing = new TextEncoder().encode('a\r\nb\r\n')
    expect(new TextDecoder().decode(normalizePatchBytes(withTrailing).bytes)).toBe('a\nb\n')

    const withoutTrailing = new TextEncoder().encode('a\r\nb')
    expect(new TextDecoder().decode(normalizePatchBytes(withoutTrailing).bytes)).toBe('a\nb')
  })

  it('strips a leading UTF-8 BOM (EF BB BF) and reports normalised', () => {
    const input = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0A])
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(true)
    expect(Array.from(bytes)).toEqual([0x61, 0x0A])
  })

  it('rewrites CRLF inside a BOM-leading input в one pass', () => {
    const input = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0D, 0x0A, 0x62])
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(true)
    expect(Array.from(bytes)).toEqual([0x61, 0x0A, 0x62])
  })

  it('handles empty input', () => {
    const input = new Uint8Array(0)
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(false)
    expect(bytes.length).toBe(0)
  })

  it('handles trailing lone CR at end-of-buffer (no following LF) — preserved verbatim', () => {
    const input = new Uint8Array([0x61, 0x0D])
    const { bytes, normalised } = normalizePatchBytes(input)
    expect(normalised).toBe(false)
    expect(bytes).toBe(input)
  })
})

// === Hash stability: F2 fingerprint via canonicalHashOfBytes ================

describe('recipe/patch — canonicalHashOfBytes applies F5 transparently (hash stability)', () => {
  it('CRLF and LF inputs yield the same sha512-hex (cross-platform fingerprint stability)', () => {
    const lfBytes   = LF_PATCH_BYTES
    const crlfBytes = toCRLF(lfBytes)
    // sanity: CRLF version is strictly longer (at least one LF was rewritten).
    expect(crlfBytes.byteLength).toBeGreaterThan(lfBytes.byteLength)
    expect(canonicalHashOfBytes(crlfBytes)).toBe(canonicalHashOfBytes(lfBytes))
    expect(canonicalHashOfBytes(crlfBytes)).toBe(LF_PATCH_HASH)
  })

  it('BOM-leading input yields the same sha512-hex as the bare LF input', () => {
    const lfBytes  = new TextEncoder().encode('a\nb\nc\n')
    const bomBytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...lfBytes])
    expect(canonicalHashOfBytes(bomBytes)).toBe(canonicalHashOfBytes(lfBytes))
  })

  it('string and Uint8Array inputs containing the same logical content hash identically', () => {
    const str   = 'a\r\nb\r\n'
    const bytes = new TextEncoder().encode(str)
    expect(canonicalHashOfBytes(str)).toBe(canonicalHashOfBytes(bytes))
  })
})

// === Diagnostic factories ===================================================

describe('recipe/patch — RECIPE_PATCH_NORMALISED diagnostic factory', () => {
  it('builds the canonical info-severity diagnostic shape per ADR-0014 §5', () => {
    const d = patchNormalizedDiagnostic('lodash@4.17.21')
    expect(d.code).toBe('RECIPE_PATCH_NORMALISED')
    expect(d.severity).toBe('info')
    expect(d.subject).toBe('lodash@4.17.21')
    expect(typeof d.message).toBe('string')
    expect(d.message.length).toBeGreaterThan(0)
  })

  it('emitPatchNormalized forwards through the callback exactly once and is silent without one', () => {
    const seen: Diagnostic[] = []
    emitPatchNormalized('lodash@4.17.21', d => seen.push(d))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.code).toBe('RECIPE_PATCH_NORMALISED')

    expect(() => emitPatchNormalized('lodash@4.17.21')).not.toThrow()
  })
})

// === Integration: yarn-berry-v9 + pnpm-v9 adapter emission ==================

describe('recipe/patch — adapter integration with synthetic CRLF workspace', () => {
  function withCRLFWorkspace<T>(fn: (root: string) => T): T {
    const tempParent = mkdtempSync(resolve(tmpdir(), 'lockfile-patch-f5-'))
    const tempRoot   = resolve(tempParent, 'workspace')
    try {
      cpSync(templateDir('patch-yarn'), tempRoot, { recursive: true })
      const lfBytes   = readFileSync(resolve(tempRoot, PATCH_FILE))
      const crlfBytes = toCRLF(lfBytes)
      writeFileSync(resolve(tempRoot, PATCH_FILE), crlfBytes)
      return fn(tempRoot)
    } finally {
      rmSync(tempParent, { recursive: true, force: true })
    }
  }

  it('yarn-berry-v9: CRLF patch bytes produce the same Node.patch as the LF source and emit RECIPE_PATCH_NORMALISED', () => {
    withCRLFWorkspace(workspaceRoot => {
      const graph = parse('yarn-berry-v9', fixtureText('patch-yarn/yarn-berry-v9.lock'), { workspaceRoot })
      expect(graph.getNode(patchedNodeId('lodash', '4.17.21', LF_PATCH_HASH))?.patch).toBe(LF_PATCH_HASH)
      const normalised = graph.diagnostics().filter(
        d => d.code === 'RECIPE_PATCH_NORMALISED' && d.subject === patchedNodeId('lodash', '4.17.21', LF_PATCH_HASH),
      )
      expect(normalised).toHaveLength(1)
      expect(normalised[0]!.severity).toBe('info')
    })
  })

  it('pnpm-v9: CRLF patch bytes produce the same Node.patch as the LF source and emit RECIPE_PATCH_NORMALISED', () => {
    withCRLFWorkspace(workspaceRoot => {
      const graph = parse('pnpm-v9', fixtureText('patch-yarn/pnpm-v9.lock'), { workspaceRoot })
      expect(graph.getNode('lodash@4.17.21')?.patch).toBe(LF_PATCH_HASH)
      const normalised = graph.diagnostics().filter(
        d => d.code === 'RECIPE_PATCH_NORMALISED' && d.subject === 'lodash@4.17.21',
      )
      expect(normalised).toHaveLength(1)
      expect(normalised[0]!.severity).toBe('info')
    })
  })

  it('LF-only workspace bytes do not emit RECIPE_PATCH_NORMALISED — observability fires only on actual rewrites', () => {
    const graph = parse('yarn-berry-v9', fixtureText('patch-yarn/yarn-berry-v9.lock'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode(patchedNodeId('lodash', '4.17.21', LF_PATCH_HASH))?.patch).toBe(LF_PATCH_HASH)
    expect(graph.diagnostics().filter(d => d.code === 'RECIPE_PATCH_NORMALISED')).toHaveLength(0)
  })
})
