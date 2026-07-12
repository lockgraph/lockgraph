import { describe, expect, it } from 'vitest'
import type { FormatId } from '../../main/ts/index.ts'
import { sourceCapabilitiesOf } from '../../main/ts/completeness/capabilities.ts'

const formats: readonly FormatId[] = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
  'yarn-classic',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
  'lockgraph',
]

describe('sourceCapabilitiesOf', () => {
  it('defines a conservative floor for every public format', () => {
    for (const format of formats) {
      const result = sourceCapabilitiesOf(format)
      expect(result.floor).toEqual(expect.objectContaining({
        projectTopology: expect.any(String),
        resolvedGraph: expect.any(String),
        edgeKinds: expect.any(String),
        peerModel: expect.any(String),
        resolutionPolicy: expect.any(String),
        packageMetadata: expect.any(String),
        artifacts: expect.any(String),
        layout: expect.any(String),
        verification: 'unverified',
      }))
    }
  })

  it('uses complete graph and edge-kind floors only where the lock encodes them', () => {
    expect(sourceCapabilitiesOf('npm-3').floor).toMatchObject({
      projectTopology: 'complete',
      resolvedGraph: 'complete',
      edgeKinds: 'partial',
      peerModel: 'declared',
    })
    expect(sourceCapabilitiesOf('pnpm-v6').floor).toMatchObject({
      projectTopology: 'partial',
      resolvedGraph: 'complete',
      edgeKinds: 'complete',
      peerModel: 'virtualized',
    })
    expect(sourceCapabilitiesOf('pnpm-v9').floor).toMatchObject({
      projectTopology: 'partial',
      resolvedGraph: 'partial',
      edgeKinds: 'partial',
      peerModel: 'virtualized',
    })
    expect(sourceCapabilitiesOf('bun-text').floor).toMatchObject({
      projectTopology: 'complete',
      resolvedGraph: 'complete',
      edgeKinds: 'complete',
      peerModel: 'declared',
    })
  })

  it('keeps override authority below authored for every lock-only floor', () => {
    for (const format of formats) {
      expect(sourceCapabilitiesOf(format).floor.resolutionPolicy).not.toBe('authored')
    }
  })

  it('reports pnpm-v5 policy ambiguity only when manager generation is unknown', () => {
    const unknown = sourceCapabilitiesOf('pnpm-v5')
    expect(unknown.floor.resolutionPolicy).toBe('outcome-only')
    expect([...unknown.ambiguousDimensions]).toEqual(['resolutionPolicy'])

    expect(sourceCapabilitiesOf('pnpm-v5', '5.18.10')).toMatchObject({
      floor: { resolutionPolicy: 'outcome-only' },
    })
    expect(sourceCapabilitiesOf('pnpm-v5', '6.35.1')).toMatchObject({
      floor: { resolutionPolicy: 'normalized' },
    })
    expect(sourceCapabilitiesOf('pnpm-v5', '7')).toMatchObject({
      floor: { resolutionPolicy: 'normalized' },
    })
    expect(sourceCapabilitiesOf('pnpm-v5', '6.35.1').ambiguousDimensions.size).toBe(0)
  })

  it('does not report npm-2 generation ambiguity', () => {
    expect(sourceCapabilitiesOf('npm-2').ambiguousDimensions.size).toBe(0)
    expect(sourceCapabilitiesOf('npm-2', '7.24.2').ambiguousDimensions.size).toBe(0)
    expect(sourceCapabilitiesOf('npm-2', '10.9.2').ambiguousDimensions.size).toBe(0)
  })

  it('keeps malformed pnpm generations conservative', () => {
    for (const generation of ['6.not-semver', '6.35.1 trailing', '7.']) {
      const result = sourceCapabilitiesOf('pnpm-v5', generation)
      expect(result.floor.resolutionPolicy).toBe('outcome-only')
      expect([...result.ambiguousDimensions]).toEqual(['resolutionPolicy'])
    }
  })
})
