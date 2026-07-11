import { describe, expect, it } from 'vitest'

import {
  readYaml,
  emitYaml,
  flowMap,
  quoted,
} from '../../main/ts/formats/_pnpm-yaml.ts'

describe('readYaml', () => {
  it('reads a block scalar (`key: |`) as an empty string and skips its body lines', () => {
    // The literal-block body is consumed but not preserved — the value collapses to ''.
    const y = readYaml('key: |\n  line one\n  line two\nother: 5\n')
    expect(y).toEqual({ key: '', other: '5' })
  })

  it('reads a folded block scalar (`key: >`) the same way (empty string, body skipped)', () => {
    const y = readYaml('folded: >\n  wrapped text here\nnext: tail\n')
    expect(y).toEqual({ folded: '', next: 'tail' })
  })

  it('strips a trailing ` # comment` from an inline scalar value', () => {
    const y = readYaml('key: value # a trailing comment\n')
    expect(y).toEqual({ key: 'value' })
  })

  it('keeps a `#` that is inside a quoted scalar (not treated as a comment)', () => {
    const y = readYaml(`key: 'a # b'\n`)
    expect(y).toEqual({ key: 'a # b' })
  })

  it('parses a flow item that has no colon by dropping it', () => {
    // A flow map whose second item lacks a `:` is skipped; the valid one survives.
    const y = readYaml('m: {a: 1, bogus}\n')
    expect(y).toEqual({ m: { a: '1' } })
  })
})

describe('emitYaml', () => {
  it('emits a top-level flow map, array, empty array, boolean and quoted scalar', () => {
    const out = emitYaml(
      { fm: flowMap({ a: '1', b: '2' }), arr: ['x', 'y'], empt: [], flag: true, q: quoted('9.0') },
      { topLevelOrder: ['fm', 'arr', 'empt', 'flag', 'q'] },
    )
    expect(out).toBe(
      'fm: {a: 1, b: 2}\n\narr:\n- x\n- y\n\nempt: []\n\nflag: true\n\nq: \'9.0\'\n',
    )
  })

  it('emits nested block-map values: null, quoted, empty array, nested object, empty flow map', () => {
    const out = emitYaml(
      { parent: { nul: null, q: quoted("x'y"), arr: [], nested: { deep: 'v' }, fm: flowMap({}) } },
      { topLevelOrder: ['parent'] },
    )
    expect(out).toBe(
      'parent:\n' +
        '  nul:\n' +
        "  q: 'x''y'\n" +
        '  arr: []\n' +
        '  nested:\n' +
        '    deep: v\n' +
        '  fm: {}\n',
    )
  })

  it('emits a flow map whose values are a nested object and an array (recursion)', () => {
    const out = emitYaml(
      { r: flowMap({ inner: { a: 'b' } as unknown, list: ['p', 'q'] as unknown } as Record<string, unknown>) },
      { topLevelOrder: ['r'] },
    )
    expect(out).toBe('r: {inner: {a: b}, list: [p, q]}\n')
  })
})
