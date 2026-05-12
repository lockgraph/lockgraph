// Interop conversion matrix: pure data + types. No I/O, no graph predicates,
// no dispatch. Observation logic lives in `_observe.ts`; `_fixtures.ts` owns the
// corpus arrays that contracts pin via `fixtureSubset`.

import {
  BERRY_SHARED_FIXTURES,
  BERRY_SHARED_NO_GIT_FOR_V9,
  BERRY_WORKSPACE_FIXTURES,
  CLASSIC_SHARED_FIXTURES,
} from './_fixtures.ts'
import type { FormatId } from './_types.ts'

export type { FormatId } from './_types.ts'

export type PreservedFeature =
  | 'nodes'
  | 'edges'
  | 'edge-kinds'
  | 'integrity'
  | 'resolved-url'
  | 'tarballs'
  | 'workspace-membership'
  | 'patch-slots'
  | 'peer-virt'
  | 'conditions'

export const ALL_FEATURES: PreservedFeature[] = [
  'nodes',
  'edges',
  'edge-kinds',
  'integrity',
  'resolved-url',
  'tarballs',
  'workspace-membership',
  'patch-slots',
  'peer-virt',
  'conditions',
]

// Typed discriminants for contract entries. `_observe.ts` switch arms must cover
// every member of these unions exhaustively (TS `satisfies never` default), so
// adding a new feature/field to the matrix surfaces as a compile error in the
// observer rather than a runtime throw.
export type LossFeature =
  | 'conditions'
  | 'peer-virt'
  | 'patch'
  | 'virtual'
  | 'workspace-metadata'
  | 'compressionLevel'
  | 'cacheKey'
  | 'sentinel-collapsed'
  | 'multi-spec-collapsed'

export type AdditionField =
  | '__metadata.version'
  | 'workspace metadata'
  | 'conditions default'
  | 'compressionLevel default'

export type PassthroughFeature =
  | 'conditions'
  | 'compressionLevel'

export type LossEntry = {
  feature: LossFeature
  diagnostic: string
  severity: 'warning' | 'info'
  rationale: string
}

export type AdditionEntry = {
  field: AdditionField
  source: 'static' | 'caller-option' | 'manifest-derived' | 'enrich-synthesized'
  diagnostic?: string
  severity?: 'warning' | 'info'
  rationale: string
}

export type PassthroughEntry = {
  feature: PassthroughFeature
  diagnostic: string
  severity: 'warning' | 'info'
  rationale: string
}

export type ReentrancyClass = 'lossless-reentrant' | 'one-way-lossy' | 'asymmetric'

export type ConversionContract = {
  from: FormatId
  to: FormatId
  preserved: PreservedFeature[]
  lost: LossEntry[]
  added: AdditionEntry[]
  passthrough: PassthroughEntry[]
  reentrancy: ReentrancyClass
  enrichRequired?: ('manifests' | string)[]
  fixtureSubset?: string[]
}

const withoutFeatures = (...features: PreservedFeature[]): PreservedFeature[] =>
  ALL_FEATURES.filter(feature => !features.includes(feature))

type BerryFormat = Extract<FormatId, `yarn-berry-${string}`>
type BerryVersion = 4 | 5 | 6 | 8 | 9
const BERRY_VERSION: Record<BerryFormat, BerryVersion> = {
  'yarn-berry-v4': 4,
  'yarn-berry-v5': 5,
  'yarn-berry-v6': 6,
  'yarn-berry-v8': 8,
  'yarn-berry-v9': 9,
}
const BERRY_FORMATS: BerryFormat[] = ['yarn-berry-v4', 'yarn-berry-v5', 'yarn-berry-v6', 'yarn-berry-v8', 'yarn-berry-v9']

// Conditions support landed in v5; v4 cannot encode conditions.
const supportsConditions = (format: BerryFormat): boolean => BERRY_VERSION[format] >= 5

// v8/v9 use a cacheKey-prefixed checksum (`cacheKey/deadbeef`) which the v5/v6
// stringifier strips down to plain `deadbeef`, so integrity/tarballs round-trip
// only when the source is not v8/v9 OR the destination is v8/v9. Crossing the
// v8 boundary downward is the only direction that drops integrity/tarballs.
const integrityRoundTrips = (from: BerryFormat, to: BerryFormat): boolean =>
  BERRY_VERSION[from] < 8 || BERRY_VERSION[to] >= 8

const fromCode = (format: FormatId): string => format.replaceAll('-', '_').toUpperCase()

function passthroughEntry(
  from: BerryFormat,
  to: BerryFormat,
  feature: 'conditions' | 'compressionLevel',
  rationale: string,
): PassthroughEntry {
  return {
    feature,
    diagnostic: `INTEROP_${fromCode(from)}_TO_${fromCode(to)}_${feature.toUpperCase()}_PASSTHROUGH`,
    severity: 'info',
    rationale,
  }
}

function conditionsLossEntry(from: BerryFormat, to: BerryFormat): LossEntry {
  return {
    feature: 'conditions',
    diagnostic: `INTEROP_${fromCode(from)}_TO_${fromCode(to)}_CONDITIONS_DROPPED`,
    severity: 'warning',
    rationale: 'v4 stringifier warns and drops conditions blocks',
  }
}

function berryFixtureSubsetFor(from: BerryFormat, to: BerryFormat): readonly string[] {
  const versions = new Set<BerryVersion>([BERRY_VERSION[from], BERRY_VERSION[to]])
  if (versions.has(9) && versions.has(4)) return BERRY_SHARED_NO_GIT_FOR_V9
  if (versions.has(4)) return BERRY_SHARED_FIXTURES
  return BERRY_WORKSPACE_FIXTURES
}

// Berry pair: derive preserved/lost/passthrough from version capability checks.
// `to` < v8 drops integrity/tarballs; `to` = v4 drops conditions outright; both
// passthrough conditions only when `from` and `to` both support them.
function buildBerryPair(from: BerryFormat, to: BerryFormat): ConversionContract {
  const fromHasConditions = supportsConditions(from)
  const toHasConditions = supportsConditions(to)

  const preservedDrop: PreservedFeature[] = []
  if (!integrityRoundTrips(from, to)) preservedDrop.push('integrity', 'tarballs')
  if (fromHasConditions && !toHasConditions) preservedDrop.push('conditions')

  const lost: LossEntry[] = []
  if (fromHasConditions && !toHasConditions) lost.push(conditionsLossEntry(from, to))

  const passthrough: PassthroughEntry[] = []
  if (fromHasConditions && toHasConditions) {
    passthrough.push(passthroughEntry(from, to, 'conditions', conditionsRationale(from, to)))
  }
  passthrough.push(
    passthroughEntry(from, to, 'compressionLevel', 'runtime preserves compressionLevel as opaque __metadata'),
  )

  // Reentrancy: a pair is lossless when nothing falls off going from->to. With
  // version-pair symmetry, the upgrade direction (older->newer) is always
  // lossless and the downgrade direction (newer->older) is one-way-lossy if
  // either integrity or conditions actually drop.
  const reentrancy: ReentrancyClass = preservedDrop.length === 0 ? 'lossless-reentrant' : 'one-way-lossy'

  return {
    from,
    to,
    preserved: preservedDrop.length === 0 ? ALL_FEATURES : withoutFeatures(...preservedDrop),
    lost,
    added: [],
    passthrough,
    reentrancy,
    fixtureSubset: [...berryFixtureSubsetFor(from, to)],
  }
}

function conditionsRationale(from: BerryFormat, to: BerryFormat): string {
  if (BERRY_VERSION[from] >= 8 && BERRY_VERSION[to] >= 8) {
    return 'v8 and v9 both preserve the conditions sidecar verbatim'
  }
  if (BERRY_VERSION[from] === 5 && BERRY_VERSION[to] === 6 || BERRY_VERSION[from] === 6 && BERRY_VERSION[to] === 5) {
    return 'v5 and v6 both preserve conditions blocks'
  }
  // newer<->{v5,v6}: the older end of the pair already encodes conditions natively.
  const olderToken = BERRY_VERSION[to] < BERRY_VERSION[from] ? `v${BERRY_VERSION[to]}` : `v${BERRY_VERSION[from]}`
  return `${olderToken} already carries conditions blocks unchanged`
}

const BERRY_BERRY_PAIRS: Array<[BerryFormat, BerryFormat]> = [
  ['yarn-berry-v9', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v9'],
  ['yarn-berry-v8', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v8'],
  ['yarn-berry-v6', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v6'],
  ['yarn-berry-v5', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v5'],
]

const BERRY_BERRY_CONTRACTS: ConversionContract[] = BERRY_BERRY_PAIRS.map(([from, to]) => buildBerryPair(from, to))

// Classic -> Berry: preserved subset depends on whether `to` retains
// integrity/tarballs (v8/v9) and synthesized additions accumulate as the
// destination format grows new fields (conditions in v5+, compressionLevel in v8+).
function buildClassicToBerry(to: BerryFormat): ConversionContract {
  const preserved: PreservedFeature[] = ['nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership']
  // v8/v9 round-trip integrity/tarballs from classic; older targets cannot.
  const preservesIntegrityFromClassic = BERRY_VERSION[to] >= 8
  if (preservesIntegrityFromClassic) preserved.splice(3, 0, 'integrity', 'tarballs')

  const added: AdditionEntry[] = [
    {
      field: '__metadata.version',
      source: 'static',
      diagnostic: `INTEROP_YARN_CLASSIC_TO_${fromCode(to)}_PREAMBLE_SYNTHESIZED`,
      severity: 'info',
      rationale: 'berry outputs always synthesize a __metadata.version preamble',
    },
    {
      field: 'workspace metadata',
      source: 'manifest-derived',
      diagnostic: `INTEROP_YARN_CLASSIC_TO_${fromCode(to)}_WORKSPACE_SYNTHESIZED`,
      severity: 'info',
      rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
    },
  ]
  if (supportsConditions(to)) {
    added.push({
      field: 'conditions default',
      source: 'static',
      rationale: `${to.slice('yarn-berry-'.length)} can carry conditions but the current conversion path leaves them absent`,
    })
  }
  if (preservesIntegrityFromClassic) {
    added.push({
      field: 'compressionLevel default',
      source: 'static',
      rationale: `${to.slice('yarn-berry-'.length)} can carry compressionLevel but the current conversion path leaves it absent`,
    })
  }

  const lost: LossEntry[] = [
    {
      feature: 'multi-spec-collapsed',
      diagnostic: `INTEROP_YARN_CLASSIC_TO_${fromCode(to)}_MULTI_SPEC_COLLAPSED`,
      severity: 'info',
      rationale: 'berry canonicalises multi-spec classic entry keys to a single npm locator per node',
    },
  ]

  return {
    from: 'yarn-classic',
    to,
    preserved,
    lost,
    added,
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  }
}

// Berry -> Classic: classic flattens away peer/patch/virtual/workspace metadata
// and has no `__metadata` block, so cacheKey/compressionLevel always drop. v4
// has no conditions to start with, so the conditions loss only fires from v5+.
function buildBerryToClassic(from: BerryFormat): ConversionContract {
  const fromHasConditions = supportsConditions(from)
  const lost: LossEntry[] = [
    {
      feature: 'peer-virt',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_PEER_VIRT_DROPPED`,
      severity: 'warning',
      rationale: 'classic flattens peerContext away on emit',
    },
    {
      feature: 'patch',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_PATCH_DROPPED`,
      severity: 'warning',
      rationale: 'classic cannot encode patch slots',
    },
    {
      feature: 'sentinel-collapsed',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_SENTINEL_COLLAPSED`,
      severity: 'warning',
      rationale: 'classic has no slot-value namespace, so unresolved- sentinel patches (ADR-0011) collapse on emit',
    },
    {
      feature: 'virtual',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_VIRTUAL_DROPPED`,
      severity: 'warning',
      rationale: 'classic has no virtual key space',
    },
    {
      feature: 'workspace-metadata',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED`,
      severity: 'info',
      rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
    },
  ]
  if (fromHasConditions) {
    lost.push({
      feature: 'conditions',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_CONDITIONS_DROPPED`,
      severity: 'warning',
      rationale: 'classic has no conditions field',
    })
  }
  lost.push(
    {
      feature: 'compressionLevel',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED`,
      severity: 'info',
      rationale: 'classic has no __metadata section',
    },
    {
      feature: 'cacheKey',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_CACHEKEY_DROPPED`,
      severity: 'info',
      rationale: 'classic has no __metadata section',
    },
  )

  return {
    from,
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost,
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  }
}

// TODO(adr-0020): ADR-0018 explicitly deferred compressionLevel, but the
// current core preserves unknown __metadata extras across the whole berry
// family. The interop contracts therefore pin observed passthrough behavior
// instead of the dispatch brief's v8/v9-only assumption.
export const CONTRACTS: ConversionContract[] = [
  ...BERRY_BERRY_CONTRACTS,
  ...BERRY_FORMATS.map(buildClassicToBerry),
  ...BERRY_FORMATS.map(buildBerryToClassic),
]
