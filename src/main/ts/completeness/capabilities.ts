import type { FormatId } from '../index.ts'
import type {
  CompletenessDimension,
  CompletenessProfile,
  SourceCapabilityResult,
} from './types.ts'

const npm1: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'partial',
  resolvedGraph: 'partial',
  edgeKinds: 'partial',
  peerModel: 'none',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'source-native-encoded',
  verification: 'unverified',
})

const npm23: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'complete',
  resolvedGraph: 'complete',
  edgeKinds: 'partial',
  peerModel: 'declared',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'source-native-encoded',
  verification: 'unverified',
})

const yarnClassic: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'partial',
  resolvedGraph: 'partial',
  edgeKinds: 'partial',
  peerModel: 'none',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const yarnBerry: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'complete',
  resolvedGraph: 'partial',
  edgeKinds: 'partial',
  peerModel: 'virtualized',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const pnpmV5OutcomeOnly: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'partial',
  resolvedGraph: 'partial',
  edgeKinds: 'partial',
  peerModel: 'virtualized',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const pnpmV5Normalized: Readonly<CompletenessProfile> = Object.freeze({
  ...pnpmV5OutcomeOnly,
  resolutionPolicy: 'normalized',
})

const pnpmV6: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'partial',
  resolvedGraph: 'complete',
  edgeKinds: 'complete',
  peerModel: 'virtualized',
  resolutionPolicy: 'normalized',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const pnpmV9: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'partial',
  resolvedGraph: 'partial',
  edgeKinds: 'partial',
  peerModel: 'virtualized',
  resolutionPolicy: 'normalized',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const bunText: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'complete',
  resolvedGraph: 'complete',
  edgeKinds: 'complete',
  peerModel: 'declared',
  resolutionPolicy: 'normalized',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const lockgraph: Readonly<CompletenessProfile> = Object.freeze({
  projectTopology: 'complete',
  resolvedGraph: 'complete',
  edgeKinds: 'complete',
  peerModel: 'virtualized',
  resolutionPolicy: 'outcome-only',
  packageMetadata: 'partial',
  artifacts: 'identified',
  layout: 'none',
  verification: 'unverified',
})

const noAmbiguity = (): ReadonlySet<CompletenessDimension> => new Set()

function pnpmGenerationMajor(generation: string | undefined): number | undefined {
  if (generation === undefined) return undefined
  const match = generation.trim().match(/^v?(\d+)(?:\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)?$/)
  return match === null ? undefined : Number(match[1])
}

function pnpmV5Capabilities(generation: string | undefined): SourceCapabilityResult {
  const major = pnpmGenerationMajor(generation)
  if (major === 6 || major === 7) {
    return {
      floor: pnpmV5Normalized,
      ambiguousDimensions: noAmbiguity(),
    }
  }
  if (major !== undefined && major >= 3 && major <= 5) {
    return {
      floor: pnpmV5OutcomeOnly,
      ambiguousDimensions: noAmbiguity(),
    }
  }
  return {
    floor: pnpmV5OutcomeOnly,
    ambiguousDimensions: new Set<CompletenessDimension>(['resolutionPolicy']),
  }
}

export function sourceCapabilitiesOf(
  format: FormatId,
  generation?: string,
): SourceCapabilityResult {
  switch (format) {
    case 'npm-1':
      return { floor: npm1, ambiguousDimensions: noAmbiguity() }
    case 'npm-2':
    case 'npm-3':
      return { floor: npm23, ambiguousDimensions: noAmbiguity() }
    case 'yarn-classic':
      return { floor: yarnClassic, ambiguousDimensions: noAmbiguity() }
    case 'yarn-berry-v4':
    case 'yarn-berry-v5':
    case 'yarn-berry-v6':
    case 'yarn-berry-v7':
    case 'yarn-berry-v8':
    case 'yarn-berry-v9':
    case 'yarn-berry-v10':
      return { floor: yarnBerry, ambiguousDimensions: noAmbiguity() }
    case 'pnpm-v5':
      return pnpmV5Capabilities(generation)
    case 'pnpm-v6':
      return { floor: pnpmV6, ambiguousDimensions: noAmbiguity() }
    case 'pnpm-v9':
      return { floor: pnpmV9, ambiguousDimensions: noAmbiguity() }
    case 'bun-text':
      return { floor: bunText, ambiguousDimensions: noAmbiguity() }
    case 'lockgraph':
      return { floor: lockgraph, ambiguousDimensions: noAmbiguity() }
  }
}
