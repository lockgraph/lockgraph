// Interop conversion matrix: pure data + types. No I/O, no graph predicates,
// no dispatch. Observation logic lives in `_observe.ts`; `_fixtures.ts` owns the
// corpus arrays that contracts pin via `fixtureSubset`.

import {
  BERRY_SHARED_FIXTURES,
  BERRY_SHARED_NO_GIT_FOR_V9,
  BERRY_WORKSPACE_FIXTURES,
  CLASSIC_SHARED_FIXTURES,
  CROSS_FAMILY_CLASSIC_BUN_FIXTURES,
  CROSS_FAMILY_CLASSIC_NPM3_FIXTURES,
  CROSS_FAMILY_CLASSIC_PNPM5_FIXTURES,
  CROSS_FAMILY_CLASSIC_PNPM6_FIXTURES,
  CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES,
  CROSS_FAMILY_NPM1_BUN_FIXTURES,
  CROSS_FAMILY_NPM1_CLASSIC_FIXTURES,
  CROSS_FAMILY_NPM1_PNPM9_FIXTURES,
  CROSS_FAMILY_NPM1_YB9_FIXTURES,
  CROSS_FAMILY_NPM3_CLASSIC_FIXTURES,
  CROSS_FAMILY_NPM3_BUN_FIXTURES,
  CROSS_FAMILY_PNPM5_BUN_FIXTURES,
  CROSS_FAMILY_PNPM5_CLASSIC_FIXTURES,
  CROSS_FAMILY_PNPM5_NPM3_FIXTURES,
  CROSS_FAMILY_PNPM6_BUN_FIXTURES,
  CROSS_FAMILY_PNPM6_CLASSIC_FIXTURES,
  CROSS_FAMILY_PNPM6_NPM3_FIXTURES,
  CROSS_FAMILY_PNPM9_CLASSIC_FIXTURES,
  CROSS_FAMILY_PNPM9_BUN_FIXTURES,
  CROSS_FAMILY_PNPM9_NPM3_FIXTURES,
  CROSS_FAMILY_YB9_PNPM5_FIXTURES,
  CROSS_FAMILY_YB9_PNPM6_FIXTURES,
  CROSS_FAMILY_YB_MID_BUN_FIXTURES,
  CROSS_FAMILY_YB_MID_NPM3_FIXTURES,
  CROSS_FAMILY_YB_MID_PNPM9_FIXTURES,
  CROSS_FAMILY_YB4_BUN_FIXTURES,
  CROSS_FAMILY_YB4_NPM3_FIXTURES,
  CROSS_FAMILY_YB4_PNPM9_FIXTURES,
  CROSS_FAMILY_YB9_BUN_FIXTURES,
  CROSS_FAMILY_YB9_NPM3_FIXTURES,
  CROSS_FAMILY_YB9_PNPM9_FIXTURES,
  NPM_SHARED_FIXTURES,
  PNPM_SHARED_FIXTURES,
  PNPM_V6_V9_FIXTURES,
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
  | 'workspace'
  | 'workspace-rekey'
  | 'compressionLevel'
  | 'cacheKey'
  | 'sentinel-collapsed'
  | 'multi-spec-collapsed'
  | 'edges'
  | 'edge-kinds'
  | 'tarballs'
  | 'resolved-url'

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
type BerryVersion = 4 | 5 | 6 | 7 | 8 | 9 | 10
type MidBerryFormat = Extract<BerryFormat, 'yarn-berry-v5' | 'yarn-berry-v6' | 'yarn-berry-v8'>
type MidBerryVersion = Exclude<BerryVersion, 4 | 7 | 9 | 10>
const BERRY_VERSION: Record<BerryFormat, BerryVersion> = {
  'yarn-berry-v4': 4,
  'yarn-berry-v5': 5,
  'yarn-berry-v6': 6,
  'yarn-berry-v7': 7,
  'yarn-berry-v8': 8,
  'yarn-berry-v9': 9,
  'yarn-berry-v10': 10,
}
const BERRY_FORMATS: BerryFormat[] = ['yarn-berry-v4', 'yarn-berry-v5', 'yarn-berry-v6', 'yarn-berry-v7', 'yarn-berry-v8', 'yarn-berry-v9']
const MID_BERRY_VERSIONS: MidBerryVersion[] = [5, 6, 8]
const midBerryFormat = (version: MidBerryVersion): MidBerryFormat => `yarn-berry-v${version}` as MidBerryFormat

// Conditions support landed in v5; v4 cannot encode conditions.
const supportsConditions = (format: BerryFormat): boolean => BERRY_VERSION[format] >= 5

// ADR-0014 §4.F1: integrity is held canonical (`sha512-<base64>` SRI) on the
// Graph and re-encoded at the adapter stringify boundary into the per-version
// PM-native form (raw hex for v4/v5/v6; cacheKey-prefixed for v8/v9). Cross-
// version conversions preserve the canonical bytes byte-equal — no integrity
// drop in any direction. `RECIPE_INTEGRITY_TRANSLATED` maps to
// `INTEROP_..._INTEGRITY_PASSTHROUGH` per ADR-0014 §5.
const integrityRoundTrips = (_from: BerryFormat, _to: BerryFormat): boolean => true

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
  ['yarn-berry-v9', 'yarn-berry-v7'],
  ['yarn-berry-v7', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v9'],
  ['yarn-berry-v9', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v9'],
  ['yarn-berry-v8', 'yarn-berry-v7'],
  ['yarn-berry-v7', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v8'],
  ['yarn-berry-v8', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v8'],
  ['yarn-berry-v7', 'yarn-berry-v6'],
  ['yarn-berry-v6', 'yarn-berry-v7'],
  ['yarn-berry-v7', 'yarn-berry-v5'],
  ['yarn-berry-v5', 'yarn-berry-v7'],
  ['yarn-berry-v7', 'yarn-berry-v4'],
  ['yarn-berry-v4', 'yarn-berry-v7'],
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
  // ADR-0014 §4.F1: canonical SRI integrity preserved across all berry
  // versions (raw hex / cacheKey-prefixed are encoding-only at the adapter
  // boundary). All berry targets carry integrity/tarballs through from classic.
  const preservesIntegrityFromClassic = true
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

// === npm intra-family contracts (ADR-0020 Phase A) ==========================
//
// 6 directional pairs across npm-1 / npm-2 / npm-3. Shape deltas per ADR-0021:
//
//   npm-1  recursive `dependencies` tree; no `packages` block; no workspace
//          primitive; no patch slot; peer edges sidecar-only.
//   npm-2  DUAL-mode topology — both `packages` (path-keyed, authoritative)
//          and `dependencies` (legacy nested mirror). Workspace via `link: true`.
//   npm-3  packages-only (no legacy `dependencies` mirror). Workspace via
//          `link: true`.
//
// Graph-level loss analysis (ADR-0020 §4 ConversionContract derivation):
//
//   npm-1 → npm-{2,3}: npm-1 sources carry none of `peer-virt` (parsers always
//     set `peerContext: []`), patches, or workspace metadata, so no graph
//     feature ever drops; reentrancy is lossless across the corpus.
//
//   npm-{2,3} → npm-1: three shape-imposed losses present in the npm-1
//     downgrade path:
//       (a) workspace member nodes drop (NPM_V1_WORKSPACES_UNSAFE +
//           RECIPE_FEATURE_DROPPED feature='workspace');
//       (b) PM-native tarball metadata (`bin`, `engines`, `funding`, etc.)
//           is not part of the npm-1 entry schema (ADR-0021 §A.npm-1);
//       (c) deeply-hoisted transitive edges may fail to round-trip — the
//           cross-format emit path runs without an npm-1 sidecar, so the
//           BFS hoist plan can place a dep at a path where its `requires`
//           target is no longer visible from the consumer's scope; the
//           re-parse warns NPM_UNRESOLVED_DEP and drops the edge.
//     `preserved` therefore omits `edges`, `edge-kinds`, `tarballs`; the
//     corpus narrows `git-github-tarball` (git URL becomes node version,
//     irreducible identity collision) and workspace-bearing fixtures.
//     Reentrancy: asymmetric — round-trip via the nested tree shape cannot
//     reconstruct the source faithfully.
//
//   npm-2 ↔ npm-3: legacy `dependencies` mirror is encoding-only; npm parsers
//     never project it onto the graph (npm-3 parser even surfaces
//     NPM_V3_UNEXPECTED_LEGACY_MIRROR if encountered). Round-trip is
//     graph-lossless in both directions.
type NpmFormat = Extract<FormatId, `npm-${number}`>
const NPM_FORMATS: NpmFormat[] = ['npm-1', 'npm-2', 'npm-3']
type OlderNpmFormat = Exclude<NpmFormat, 'npm-3'>
const OLDER_NPM_FORMATS: OlderNpmFormat[] = ['npm-1', 'npm-2']

// npm-1 corpus subset — co-located with the downgrade contract that consumes
// it. Excludes:
//   - 'workspaces-basic', 'peers-multi' — carry workspace members; npm-1
//     stringifier drops them (NPM_V1_WORKSPACES_UNSAFE + RECIPE_FEATURE_DROPPED
//     feature='workspace' per ADR-0021 §A.npm-1). The
//     INTEROP_NPM_<n>_TO_NPM_1_WORKSPACE_DROPPED entry is declared regardless
//     and will fire when a workspace-bearing fixture lands.
//   - 'git-github-tarball' — npm-1 encodes git refs as `version: git+ssh://...`
//     on emit (ADR-0021 §A.npm-1, npm v6 dialect); reparse forms a NodeId
//     `<name>@git+ssh://...` distinct from the source `<name>@<semver>`.
//     Irreducible shape collision, narrow rather than declare a node-identity
//     loss feature. Mirrors buildBerryToClassic's lossy-path trade-off.
const NPM_TO_NPM_1_EXCLUDED = new Set<typeof NPM_SHARED_FIXTURES[number]>([
  'workspaces-basic',
  'peers-multi',
  'git-github-tarball',
])
const NPM_TO_NPM_1_FIXTURES = NPM_SHARED_FIXTURES.filter(
  fixture => !NPM_TO_NPM_1_EXCLUDED.has(fixture),
)

function npmToNpm1LossEntries(from: NpmFormat): LossEntry[] {
  const fromTag = fromCode(from)
  return [
    {
      feature: 'edges',
      diagnostic: `INTEROP_${fromTag}_TO_NPM_1_EDGES_DROPPED`,
      severity: 'warning',
      rationale: 'npm-1 nested-tree shape cannot carry per-pair transitive edges; peer edges and deeply-hoisted requires drop on emit',
    },
    // NOTE: EDGE_KINDS_DROPPED removed per codex r2 review — current
    // fixtureSubset (simple/peers-basic/deps-with-scopes/yarn-crlf) does not
    // exercise dev/peer/optional kind collapse on the npm-1 path; declaring
    // the code without a fixture that fires it produces silent advertisement
    // per ADR-0020 §2 honesty principle. Peer-edge drop is already covered
    // by EDGES_DROPPED + NPM_V1_PEER_DROPPED. Re-add when a fixture с mixed
    // edge kinds lands и actually exercises the collapse path.
    {
      feature: 'tarballs',
      diagnostic: `INTEROP_${fromTag}_TO_NPM_1_TARBALLS_DROPPED`,
      severity: 'warning',
      rationale: 'npm-1 entry schema carries only version/resolved/integrity; PM-native tarball fields (bin, engines, peerDependencies, funding, etc.) drop',
    },
    {
      feature: 'workspace',
      diagnostic: `INTEROP_${fromTag}_TO_NPM_1_WORKSPACE_DROPPED`,
      severity: 'warning',
      rationale: 'npm-1 has no workspace primitive; workspace member nodes drop via NPM_V1_WORKSPACES_UNSAFE on emit (current corpus narrows workspace fixtures away; entry prepared for future coverage)',
    },
  ]
}

function buildNpmIntraPair(from: NpmFormat, to: NpmFormat): ConversionContract {
  if (from === to) throw new Error(`buildNpmIntraPair: self-pair ${from}`)

  // npm-{2,3} → npm-1: shape-imposed downgrades. Each loss is declared as a
  // first-class lost[] entry so the observer can surface real INTEROP_*
  // diagnostics per ADR-0020 §2/§3, instead of communicating loss only via
  // subtraction from `preserved`.
  if (to === 'npm-1') {
    return {
      from,
      to,
      preserved: withoutFeatures('edges', 'edge-kinds', 'tarballs'),
      lost: npmToNpm1LossEntries(from),
      added: [],
      passthrough: [],
      reentrancy: 'asymmetric',
      fixtureSubset: [...NPM_TO_NPM_1_FIXTURES],
    }
  }

  // npm-1 → npm-{2,3}: lossless-reentrant (npm-1 source is feature-poor by
  // shape; nothing to lose at the graph level).
  // npm-{2,3} ↔ npm-{2,3}: legacy-mirror is encoding-only, graph identical.
  return {
    from,
    to,
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...NPM_SHARED_FIXTURES],
  }
}

const NPM_INTRA_PAIRS: Array<[NpmFormat, NpmFormat]> = []
for (const from of NPM_FORMATS) {
  for (const to of NPM_FORMATS) {
    if (from !== to) NPM_INTRA_PAIRS.push([from, to])
  }
}

const NPM_INTRA_CONTRACTS: ConversionContract[] = NPM_INTRA_PAIRS.map(
  ([from, to]) => buildNpmIntraPair(from, to),
)

// === pnpm intra-family contracts (ADR-0020 Phase B) =========================
//
// 6 directional pairs across pnpm-v5 / pnpm-v6 / pnpm-v9. Shape deltas per
// ADR-0022 §A/§B:
//
//   pnpm-v5  standalone-fit pipeline (NOT flat-core); `packages:` keys are
//            `/<name>/<version>` (slash-leading, slash-separated). No
//            patchedDependencies / overrides:patch primitive. NO settings
//            block. v5-private sidecar shape (`PnpmV5NodeSidecar`).
//   pnpm-v6  flat-core shared; `lockfileVersion: '6.0'`; `packages:` keys
//            `/<name>@<version>`; inline transitives; per-entry `dev` flag;
//            patch supported via overrides:patch (ADR-0014 §4.F2).
//   pnpm-v9  flat-core shared; `lockfileVersion: '9.0'`; `importers` always
//            present; split `packages` (static) + `snapshots` (resolved) blocks;
//            patch supported.
//
// Empirically-verified loss profile (see Phase B probe at PROBE harness):
//
//   v6 ↔ v9  CLEAN across the full v6_v9 corpus (incl. patch-yarn). Both
//            share the flat-core sidecar via `_pnpm-flat-core.ts`'s module
//            WeakMap, so tarball extras / patch slot / settings / inline
//            transitives all round-trip key-equal. → `lossless-reentrant`.
//
//   v5 ↔ {v6, v9}  TarballPayload extras (`bin`, and by extension engines/
//            cpu/os if a fixture carried them) drop when the cross-version
//            sidecar bridge is absent — v5 owns a private WeakMap in
//            `pnpm-v5.ts` distinct from the flat-core WeakMap, so neither
//            side can read the other's `hasBin`-bearing sidecar. The
//            shared `tarballPayloadOf` populates `TarballPayload.bin` on
//            parse, but the stringifiers gate `hasBin: true` only on
//            `nodeSc?.hasBin` (no fallback to `tarball.bin`), so it drops
//            on emit. Fires on `peers-basic` / `peers-multi` (loose-envify
//            CLI bin) across the corpus. → `asymmetric` reentrancy.
//
//   {v6, v9} → v5  ADDITIONALLY: patch slot drops. v5 has no patch
//            primitive (ADR-0022 §A.pnpm-v5), so `Node.patch` is dropped
//            and patched-id `TarballKey` collapses to bare `<name>@<version>`.
//            The tarball loss declaration covers the tarball-rekey side
//            effect; the patch loss declaration covers the Node.patch drop.
//            Fires on `patch-yarn` fixture (lodash patched node).
//
// Settings drop (v5 has no settings block per ADR-0022 §A.pnpm-v5) is
// emitted by the v5 stringifier as `PNPM_V5_SETTINGS_DROPPED`. Not
// duplicated as INTEROP_* — settings is an adapter-layer concern, not a
// graph-state feature; lifting it would require extending `LossFeature` +
// observer arms beyond Phase A precedent. Captured here as a known
// non-graph loss per scope-creep guard.
type PnpmFormat = Extract<FormatId, `pnpm-v${number}`>
type OlderPnpmFormat = Extract<PnpmFormat, 'pnpm-v5' | 'pnpm-v6'>
const PNPM_FORMATS: PnpmFormat[] = ['pnpm-v5', 'pnpm-v6', 'pnpm-v9']
const OLDER_PNPM_FORMATS: OlderPnpmFormat[] = ['pnpm-v5', 'pnpm-v6']
const OLDER_PNPM_VERSION: Record<OlderPnpmFormat, 5 | 6> = {
  'pnpm-v5': 5,
  'pnpm-v6': 6,
}

function pnpmV5CrossLossEntries(from: PnpmFormat, to: PnpmFormat): LossEntry[] {
  const fromTag = fromCode(from)
  const toTag = fromCode(to)
  const entries: LossEntry[] = [
    {
      feature: 'tarballs',
      diagnostic: `INTEROP_${fromTag}_TO_${toTag}_TARBALLS_DROPPED`,
      severity: 'warning',
      rationale: 'pnpm-v5 carries a private node sidecar in `pnpm-v5.ts` separate from the flat-core WeakMap in `_pnpm-flat-core.ts`; sidecar-gated tarball extras (`hasBin`, `cpu`, `os`) drop across the v5 boundary in either direction. `engines` is preserved on both sides via the `tarball.engines` fallback path (not sidecar-gated). On downgrade to v5 the patched-id `TarballKey` ALSO collapses to bare `<name>@<version>` because Node.patch drops (see PATCH_DROPPED entry).',
    },
  ]
  if (to === 'pnpm-v5') {
    entries.push({
      feature: 'patch',
      diagnostic: `INTEROP_${fromTag}_TO_${toTag}_PATCH_DROPPED`,
      severity: 'warning',
      rationale: 'pnpm-v5 has no patchedDependencies / overrides:patch primitive (ADR-0022 §A.pnpm-v5); Node.patch attribute drops on emit and the patched-id TarballKey collapses to bare locator',
    })
  }
  return entries
}

function buildPnpmIntraPair(from: PnpmFormat, to: PnpmFormat): ConversionContract {
  if (from === to) throw new Error(`buildPnpmIntraPair: self-pair ${from}`)

  // v6 ↔ v9: flat-core shared, all features round-trip key-equal.
  if (from !== 'pnpm-v5' && to !== 'pnpm-v5') {
    return {
      from,
      to,
      preserved: ALL_FEATURES,
      lost: [],
      added: [],
      passthrough: [],
      reentrancy: 'lossless-reentrant',
      fixtureSubset: [...PNPM_V6_V9_FIXTURES],
    }
  }

  // v5 ↔ {v6, v9}: tarball-extras drop (sidecar bridge); on downgrade to v5
  // also patch slot drops. fixtureSubset chooses corpus per source:
  //   - from = v5: PNPM_SHARED_FIXTURES (no patch-yarn — pnpm-v5 has no fixture
  //     for it because v5 cannot represent patches)
  //   - from ∈ {v6, v9}: PNPM_V6_V9_FIXTURES (includes patch-yarn which fires
  //     the PATCH_DROPPED loss on the v5 destination)
  const preservedDrop: PreservedFeature[] = ['tarballs']
  if (to === 'pnpm-v5') preservedDrop.push('patch-slots')
  return {
    from,
    to,
    preserved: withoutFeatures(...preservedDrop),
    lost: pnpmV5CrossLossEntries(from, to),
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: from === 'pnpm-v5' ? [...PNPM_SHARED_FIXTURES] : [...PNPM_V6_V9_FIXTURES],
  }
}

const PNPM_INTRA_PAIRS: Array<[PnpmFormat, PnpmFormat]> = []
for (const from of PNPM_FORMATS) {
  for (const to of PNPM_FORMATS) {
    if (from !== to) PNPM_INTRA_PAIRS.push([from, to])
  }
}

const PNPM_INTRA_CONTRACTS: ConversionContract[] = PNPM_INTRA_PAIRS.map(
  ([from, to]) => buildPnpmIntraPair(from, to),
)

// === cross-family yarn-berry-v9 <-> pnpm-v9 (ADR-0020 Phase C-i) ============
//
// Empirically-verified loss profile (probed via PROBE harness, mirrors
// Phase B precedent):
//
//   yarn-berry-v9 -> pnpm-v9 (in scope):
//     - 5 PreservedFeature drops fire UNIVERSALLY across every fixture due
//       to a single root cause: PM-native workspace identity conventions
//       disagree. yarn-berry stamps the root + workspace members as
//       `<pkg-name>@0.0.0-use.local`; pnpm-v9 uses path-keyed locators
//       (`.@<version>` for root, `<workspacePath>@<version>` for members).
//       Same workspace graph, two NodeId shapes → graphSubset says
//       `nodes, edges, edge-kinds, resolved-url, workspace-membership` all
//       drop. The single declared loss `workspace-rekey` covers this
//       cohesively — distinct from existing `workspace` (full primitive
//       drop, npm-1 case).
//     - `tarballs` drops on fixtures whose source carries TarballPayload
//       extras the destination cannot store via sidecar (loose-envify
//       `bin` in peers-basic / peers-multi). Same sidecar-bridge pattern
//       as Phase B v5 <-> {v6, v9}.
//     - Reentrancy: asymmetric — round-trip back through yarn-berry-v9
//       loses the pnpm-v9 path-keyed identity.
//
//   pnpm-v9 -> yarn-berry-v9 (OUT-OF-PHASE-C-i-SCOPE):
//     Two adapter-layer blockers prevent honest contract declaration:
//       (1) `_yarn-berry-core.ts:675` composes entry-key specs as
//           `<name>@<edge.attrs.range>`. pnpm-v9 parse stamps bare ranges
//           (`4.17.21`) without the `npm:` protocol prefix yarn-berry
//           syml entry-spec grammar requires. Stringify emits
//           `lodash@4.17.21` instead of `lodash@npm:4.17.21`; reparse
//           throws `PARSE_FAILED: bad entry-spec, no protocol colon`.
//           Affects every cross-family pnpm-* -> yarn-berry-* pair, not
//           just v9 <-> v9. Out of Phase C-i scope per scope-creep guard
//           (broader cross-family normalisation requiring multi-pair
//           refactor); deferred to a dedicated follow-up.
//       (2) `_yarn-berry-core.ts:790` requires sentinel patch nodes to
//           carry the original yarn-style patch resolution; pnpm-v9
//           sentinel nodes lack it (different ADR-0011 input string),
//           so the patch-yarn fixture additionally crashes stringify.
//
// Patch-yarn excluded from forward corpus (CROSS_FAMILY_YB9_PNPM9_FIXTURES):
// would require a second new LossFeature (`patch-slot-divergent`) since the
// canonical sentinel-hash inputs differ across PMs (yarn hashes the patch
// locator; pnpm hashes `<name>@<version>:<literalKey>`). First-class
// cross-family patch coverage deferred — narrow-rather-than-overdeclare per
// Phase A precedent.
function buildCrossFamilyYb9ToPnpm9(): ConversionContract {
  return {
    from: 'yarn-berry-v9',
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_PNPM_V9_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'yarn-berry stamps root + workspace members as `<name>@0.0.0-use.local`; pnpm-v9 uses path-keyed locators (`.@<version>` for root, `<workspacePath>@<version>` for members). Same workspace graph, two NodeId conventions → source workspace nodes (incl. root) are not preserved by id in the destination, and outgoing edges from those nodes appear orphaned to the comparator. Subsumes the graph-shape drops `nodes` / `edges` / `edge-kinds` / `resolved-url` / `workspace-membership`.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_PNPM_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras (`bin`, and by extension `cpu` / `os` if a fixture carried them) drop across the cross-family boundary — yarn-berry-v9 holds them in `_yarn-berry-core.ts` per-graph sidecars distinct from the pnpm-v9 flat-core WeakMap in `_pnpm-flat-core.ts`, mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on `peers-basic` / `peers-multi` (loose-envify CLI bin).',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_PNPM9_FIXTURES],
  }
}

// pnpm-v9 -> yarn-berry-v9 (ADR-0020 Phase C-ii reverse direction).
// Empirically-probed profile (truth-table per CROSS_FAMILY_YB9_PNPM9_FIXTURES):
//   - `peer-virt` drops on peers-basic / peers-multi: yarn-berry-v9 stringify
//     flattens peer-virt NodeIds via `YARN_BERRY_V9_PEER_VIRT_FLATTENED`, so
//     source `<name>@<version>(<peer-ctx>)` collapses to `<name>@<version>`.
//     This subsumes nodes / edges / edge-kinds / integrity / resolved-url
//     drops on those fixtures — the parenthesized NodeId is unreachable in
//     destination, so any id-keyed comparator (`graphSubset`) fails for it.
//   - `tarballs` drops on 5/7 fixtures (deps-with-scopes, peers-basic,
//     peers-multi, workspace-cross-refs, yarn-crlf): sidecar-bridge gap
//     mirroring Phase B (pnpm-v9 flat-core WeakMap vs yarn-berry-v9 per-graph
//     sidecars). Manifests as `engines` drop and `bin` shape divergence
//     (pnpm-v9 `"true"` literal vs yarn-berry-v9 `{<name>: "true"}` object).
//   - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally: yarn-berry
//     destinations always synthesise a `__metadata` block (version + cacheKey)
//     absent from pnpm-v9 sources. Mirrors the classic→berry precedent.
//   - NB: distinct from the forward direction (yarn-berry-v9 -> pnpm-v9) —
//     forward fires `workspace-rekey` (yarn-berry `<name>@0.0.0-use.local`
//     vs pnpm-v9 path-keyed); reverse does NOT (pnpm-v9 path-keyed locators
//     round-trip key-equal through yarn-berry). Forward preserves integrity;
//     reverse loses it (collapse-by-peer-virt cascade).
//   - `patch-yarn` remains out-of-corpus per CROSS_FAMILY_YB9_PNPM9_FIXTURES
//     (same sentinel-hash divergence rationale as forward direction).
function buildCrossFamilyPnpm9ToYb9(): ConversionContract {
  return {
    from: 'pnpm-v9',
    to:   'yarn-berry-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V9_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'yarn-berry-v9 stringify flattens peer-virt NodeIds via `YARN_BERRY_V9_PEER_VIRT_FLATTENED`: source `<name>@<version>(<peer-ctx>)` collapses to bare `<name>@<version>` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic, peers-multi).',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras drop across the cross-family boundary — pnpm-v9 holds them in the flat-core WeakMap (`_pnpm-flat-core.ts`) distinct from yarn-berry-v9 per-graph sidecars (`_yarn-berry-core.ts`), mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on `engines` (deps-with-scopes / workspace-cross-refs / yarn-crlf — e.g. `is-buffer@2.0.5`) and on `bin` shape divergence (peers-basic / peers-multi: pnpm-v9 source carries `bin: "true"` string literal, yarn-berry-v9 reparses as `bin: {<name>: "true"}` object form).',
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry destinations always synthesise a `__metadata` preamble (version + cacheKey) absent from pnpm-v9 sources; mirrors the classic→berry precedent.',
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_PNPM9_FIXTURES],
  }
}

const CROSS_FAMILY_YB9_PNPM9_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyYb9ToPnpm9(),
  buildCrossFamilyPnpm9ToYb9(),
]

// === cross-family yarn-berry-v4 <-> pnpm-v9 (ADR-0020 Phase E-i) ============
//
// Older-berry expansion of the modern cross-family ring. Probe matched the
// yb9 pair's directional loss shape on the 6-fixture shared-disk corpus:
//
//   yarn-berry-v4 -> pnpm-v9 (FORWARD, asymmetric):
//     - `workspace-rekey` is universal: yb-v4 uses the same
//       `<name>@0.0.0-use.local` root/member identity convention as yb9,
//       while pnpm-v9 remains path-keyed (`.@<version>` / `<workspacePath>@<version>`).
//       As in the yb9 pair, this subsumes the apparent graph-shape drops
//       `nodes` / `edges` / `edge-kinds` / `resolved-url` / `workspace-membership`.
//     - `tarballs` drops on peers-basic / peers-multi only: the same
//       sidecar-bridge gap between yarn-berry per-graph tarball extras and
//       pnpm-v9 flat-core WeakMap fires on the loose-envify CLI `bin` payload.
//     - No extra v4-only contract loss surfaced: raw-hex `checksum` vs
//       cacheKey-prefixed v8/v9 encodings is adapter-boundary-only
//       translation (canonical integrity survives), and v4 has no `conditions`
//       field to drop.
//
//   pnpm-v9 -> yarn-berry-v4 (REVERSE, asymmetric):
//     - `peer-virt` drops on peers-basic / peers-multi exactly as in the
//       yb9 reverse pair: the v4 stringifier flattens parenthesized peer
//       contexts (`YARN_BERRY_V4_PEER_VIRT_FLATTENED`), subsuming
//       `nodes` / `edges` / `edge-kinds` / `integrity` / `resolved-url`
//       loss on those fixtures.
//     - `tarballs` drops on deps-with-scopes / peers-basic / peers-multi /
//       yarn-crlf: same sidecar-bridge gap as yb9 reverse, with `engines`
//       loss on tarball-bearing deps and `bin` shape divergence on the peer
//       fixtures (`"true"` -> `{<name>: "true"}`).
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally, but the
//       destination literal is the v4 handshake (`4`) rather than yb9's `9`.
//     - No `conditions` loss is possible on destination: v4 predates the field.
function buildCrossFamilyYb4ToPnpm9(): ConversionContract {
  return {
    from: 'yarn-berry-v4',
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_PNPM_V9_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'yarn-berry-v4 stamps root + workspace members as `<name>@0.0.0-use.local`; pnpm-v9 uses path-keyed locators (`.@<version>` for root, `<workspacePath>@<version>` for members). Same workspace graph, two NodeId conventions → source workspace nodes (incl. root) are not preserved by id in the destination, and outgoing edges from those nodes appear orphaned to the comparator. Subsumes the graph-shape drops `nodes` / `edges` / `edge-kinds` / `resolved-url` / `workspace-membership`.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_PNPM_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras (`bin`, and by extension `cpu` / `os` if a fixture carried them) drop across the cross-family boundary — yarn-berry-v4 holds them in `_yarn-berry-core.ts` per-graph sidecars distinct from the pnpm-v9 flat-core WeakMap in `_pnpm-flat-core.ts`, mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on `peers-basic` / `peers-multi` (loose-envify CLI bin).',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB4_PNPM9_FIXTURES],
  }
}

function buildCrossFamilyPnpm9ToYb4(): ConversionContract {
  return {
    from: 'pnpm-v9',
    to:   'yarn-berry-v4',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V4_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'yarn-berry-v4 stringify flattens peer-virt NodeIds via `YARN_BERRY_V4_PEER_VIRT_FLATTENED`: source `<name>@<version>(<peer-ctx>)` collapses to bare `<name>@<version>` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic, peers-multi).',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V4_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras drop across the cross-family boundary — pnpm-v9 holds them in the flat-core WeakMap (`_pnpm-flat-core.ts`) distinct from yarn-berry-v4 per-graph sidecars (`_yarn-berry-core.ts`), mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on `engines` (deps-with-scopes / yarn-crlf — e.g. `is-buffer@2.0.5`) and on `bin` shape divergence (peers-basic / peers-multi: pnpm-v9 source carries `bin: \"true\"` string literal, yarn-berry-v4 reparses as `bin: {<name>: \"true\"}` object form).',
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_BERRY_V4_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry-v4 destinations always synthesise a `__metadata` preamble (version literal `4`, optional cacheKey) absent from pnpm-v9 sources; mirrors the classic→berry and pnpm-v9→yb9 precedents with the v4 handshake value.',
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB4_PNPM9_FIXTURES],
  }
}

const CROSS_FAMILY_YB4_PNPM9_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyYb4ToPnpm9(),
  buildCrossFamilyPnpm9ToYb4(),
]

// === cross-family yarn-berry-v{5,6,8} <-> pnpm-v9 (ADR-0020 Phase E-ii) ====
//
// Mid-stream berry expansion of the modern cross-family ring. Probe matched
// the existing yb4 / yb9 directional shapes on the widened 7-fixture
// shared-disk corpus (`workspace-cross-refs` now included):
//
//   yarn-berry-v{5,6,8} -> pnpm-v9 (FORWARD, asymmetric):
//     - `workspace-rekey` is universal, including `workspace-cross-refs`:
//       the mid-berry versions use the same `<name>@0.0.0-use.local`
//       root/member identity convention as yb4/yb9, while pnpm-v9 remains
//       path-keyed (`.@<version>` / `<workspacePath>@<version>`). As in the
//       surrounding berry generations, this subsumes the graph-shape drops
//       `nodes` / `edges` / `edge-kinds` / `resolved-url` /
//       `workspace-membership`.
//     - `tarballs` drops on peers-basic / peers-multi only: same sidecar-
//       bridge gap as yb4/yb9 forward (loose-envify CLI `bin` payload).
//
//   pnpm-v9 -> yarn-berry-v{5,6,8} (REVERSE, asymmetric):
//     - `peer-virt` drops on peers-basic / peers-multi exactly as in every
//       berry reverse pair: the stringifier flattens parenthesized peer
//       contexts (`YARN_BERRY_V{5,6,8}_PEER_VIRT_FLATTENED`), subsuming
//       `nodes` / `edges` / `edge-kinds` / `integrity` / `resolved-url`.
//     - `tarballs` drops on deps-with-scopes / peers-basic / peers-multi /
//       workspace-cross-refs / yarn-crlf: same sidecar-bridge gap as the yb9
//       reverse pair, with `engines` loss on tarball-bearing deps and `bin`
//       shape divergence on the peer fixtures (`"true"` -> `{<name>: "true"}`).
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally, with the
//       destination handshake literal `5`, `6`, or `8`.
//
// No extra mid-only contract loss surfaced: v5+ conditions support is not
// exercised by the shared-disk corpus, and v5/v6 raw-hex vs v8 cacheKey-
// prefixed checksums remain adapter-boundary-only translation
// (canonical integrity survives).
function buildCrossFamilyYbMidToPnpm9(version: MidBerryVersion): ConversionContract {
  const from = midBerryFormat(version)
  return {
    from,
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: `INTEROP_${fromCode(from)}_TO_PNPM_V9_WORKSPACE_REKEY`,
        severity:   'warning',
        rationale:  `yarn-berry-v${version} stamps root + workspace members as \`<name>@0.0.0-use.local\`; pnpm-v9 uses path-keyed locators (\`.@<version>\` for root, \`<workspacePath>@<version>\` for members). Same workspace graph, two NodeId conventions -> source workspace nodes (incl. root) are not preserved by id in the destination, and outgoing edges from those nodes appear orphaned to the comparator. Subsumes the graph-shape drops \`nodes\` / \`edges\` / \`edge-kinds\` / \`resolved-url\` / \`workspace-membership\`.`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_${fromCode(from)}_TO_PNPM_V9_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras (\`bin\`, and by extension \`cpu\` / \`os\` if a fixture carried them) drop across the cross-family boundary — yarn-berry-v${version} holds them in \`_yarn-berry-core.ts\` per-graph sidecars distinct from the pnpm-v9 flat-core WeakMap in \`_pnpm-flat-core.ts\`, mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on \`peers-basic\` / \`peers-multi\` (loose-envify CLI bin).`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB_MID_PNPM9_FIXTURES],
  }
}

function buildCrossFamilyPnpm9ToYbMid(version: MidBerryVersion): ConversionContract {
  const to = midBerryFormat(version)
  return {
    from: 'pnpm-v9',
    to,
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: `INTEROP_PNPM_V9_TO_${fromCode(to)}_PEER_VIRT_DROPPED`,
        severity:   'warning',
        rationale:  `yarn-berry-v${version} stringify flattens peer-virt NodeIds via \`YARN_BERRY_V${version}_PEER_VIRT_FLATTENED\`: source \`<name>@<version>(<peer-ctx>)\` collapses to bare \`<name>@<version>\` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic, peers-multi).`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_PNPM_V9_TO_${fromCode(to)}_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras drop across the cross-family boundary — pnpm-v9 holds them in the flat-core WeakMap (\`_pnpm-flat-core.ts\`) distinct from yarn-berry-v${version} per-graph sidecars (\`_yarn-berry-core.ts\`), mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on \`engines\` (deps-with-scopes / workspace-cross-refs / yarn-crlf — e.g. \`is-buffer@2.0.5\`) and on \`bin\` shape divergence (peers-basic / peers-multi: pnpm-v9 source carries \`bin: "true"\` string literal, yarn-berry-v${version} reparses as \`bin: {<name>: "true"}\` object form).`,
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: `INTEROP_PNPM_V9_TO_${fromCode(to)}_PREAMBLE_SYNTHESIZED`,
        severity:   'info',
        rationale:  `yarn-berry-v${version} destinations always synthesise a \`__metadata\` preamble (version literal \`${version}\`, optional cacheKey) absent from pnpm-v9 sources; mirrors the classic->berry and pnpm-v9->yb{4,9} precedents with the mid-berry handshake value.`,
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB_MID_PNPM9_FIXTURES],
  }
}

const CROSS_FAMILY_YB_MID_PNPM9_CONTRACTS: ConversionContract[] = MID_BERRY_VERSIONS.flatMap(
  version => [
    buildCrossFamilyYbMidToPnpm9(version),
    buildCrossFamilyPnpm9ToYbMid(version),
  ],
)

// === cross-family yarn-berry-v9 <-> pnpm-v{5,6} (ADR-0020 Phase E-iv) ======
//
// Older-pnpm expansion of the modern yb9 <-> pnpm-v9 pair. Probe target is
// the same 7-fixture shared-disk corpus in both older versions; `patch-yarn`
// stays out for the same sentinel-divergence reason as the pnpm-v9 pair, and
// additionally because pnpm-v5 has no patch primitive at all.
//
//   yarn-berry-v9 -> pnpm-v{5,6} (FORWARD, asymmetric):
//     - `workspace-rekey` remains universal. Both older pnpm generations stamp
//       the root as `.@<version>` and workspace members as
//       `<workspacePath>@<version>`, while yb9 uses `<name>@0.0.0-use.local>`.
//       As on the pnpm-v9 pair, this subsumes `nodes` / `edges` /
//       `edge-kinds` / `resolved-url` / `workspace-membership`.
//     - `tarballs` drops on peers-basic / peers-multi only: same cross-family
//       sidecar bridge gap as the modern pair, with the v5 destination reading
//       from its private sidecar and the v6 destination from flat-core.
//
//   pnpm-v{5,6} -> yarn-berry-v9 (REVERSE, asymmetric):
//     - `peer-virt` drops on peers-basic / peers-multi exactly as on the
//       pnpm-v9 reverse pair: yb9 flattens parenthesized peer-context ids.
//     - `tarballs` drops on deps-with-scopes / peers-basic / peers-multi /
//       workspace-cross-refs / yarn-crlf. v5 loses them across its private
//       sidecar boundary; v6 matches the flat-core -> berry-v9 shape.
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally with the
//       yb9 handshake literal `9`.
const YB9_OLDER_PNPM_FIXTURES: Record<OlderPnpmFormat, readonly string[]> = {
  'pnpm-v5': CROSS_FAMILY_YB9_PNPM5_FIXTURES,
  'pnpm-v6': CROSS_FAMILY_YB9_PNPM6_FIXTURES,
}

function buildCrossFamilyYb9ToOlderPnpm(to: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[to]
  const targetSidecar = to === 'pnpm-v5'
    ? 'the pnpm-v5 private node sidecar in `pnpm-v5.ts`'
    : 'the pnpm-v6 flat-core WeakMap in `_pnpm-flat-core.ts`'
  return {
    from: 'yarn-berry-v9',
    to,
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: `INTEROP_YARN_BERRY_V9_TO_${fromCode(to)}_WORKSPACE_REKEY`,
        severity:   'warning',
        rationale:  `yarn-berry-v9 stamps root + workspace members as \`<name>@0.0.0-use.local\`; pnpm-v${version} uses path-keyed locators (\`.@<version>\` for root, \`<workspacePath>@<version>\` for members). Same workspace graph, two NodeId conventions -> source workspace nodes (incl. root) are not preserved by id in the destination, and outgoing edges from those nodes appear orphaned to the comparator. Subsumes the graph-shape drops \`nodes\` / \`edges\` / \`edge-kinds\` / \`resolved-url\` / \`workspace-membership\`.`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_YARN_BERRY_V9_TO_${fromCode(to)}_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras (\`bin\`, and by extension \`cpu\` / \`os\` if a fixture carried them) drop across the cross-family boundary — yarn-berry-v9 holds them in \`_yarn-berry-core.ts\` per-graph sidecars distinct from ${targetSidecar}, mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on \`peers-basic\` / \`peers-multi\` (loose-envify CLI bin).`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...YB9_OLDER_PNPM_FIXTURES[to]],
  }
}

function buildCrossFamilyOlderPnpmToYb9(from: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[from]
  const sourceSidecar = from === 'pnpm-v5'
    ? 'a private node sidecar in `pnpm-v5.ts`'
    : 'the flat-core WeakMap (`_pnpm-flat-core.ts`)'
  return {
    from,
    to:   'yarn-berry-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_BERRY_V9_PEER_VIRT_DROPPED`,
        severity:   'warning',
        rationale:  `yarn-berry-v9 stringify flattens peer-virt NodeIds via \`YARN_BERRY_V9_PEER_VIRT_FLATTENED\`: pnpm-v${version} source \`<name>@<version>(<peer-ctx>)\` collapses to bare \`<name>@<version>\` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic, peers-multi).`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_BERRY_V9_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras drop across the cross-family boundary — pnpm-v${version} holds them in ${sourceSidecar} distinct from yarn-berry-v9 per-graph sidecars (\`_yarn-berry-core.ts\`), mirroring the Phase B pnpm-v5 <-> {v6,v9} bridge gap. Fires on \`engines\` (deps-with-scopes / workspace-cross-refs / yarn-crlf — e.g. \`is-buffer@2.0.5\`) and on \`bin\` shape divergence (peers-basic / peers-multi: pnpm-v${version} source carries \`bin: "true"\` or \`hasBin: true\` state that yb9 reparses as \`bin: {<name>: "true"}\` object form or drops).`,
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED`,
        severity:   'info',
        rationale:  `yarn-berry-v9 destinations always synthesise a \`__metadata\` preamble (version literal \`9\`, cacheKey \`10c0\`) absent from pnpm-v${version} sources; mirrors the classic->berry and pnpm-v9->yb9 precedents.`,
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...YB9_OLDER_PNPM_FIXTURES[from]],
  }
}

const CROSS_FAMILY_YB9_OLDER_PNPM_CONTRACTS: ConversionContract[] = OLDER_PNPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyYb9ToOlderPnpm(format),
    buildCrossFamilyOlderPnpmToYb9(format),
  ],
)

// === cross-family yarn-berry-v9 <-> npm-3 (ADR-0020 Phase C-iii) ============
//
// Empirically-verified loss profile (probed via PROBE harness):
//
//   yarn-berry-v9 -> npm-3 (FORWARD, asymmetric):
//     - `resolved-url` (NEW LossFeature, Phase C-iii) drops universally
//       across the corpus. yarn-berry source carries canonical tarball
//       resolution `{type: 'tarball', url: 'https://registry.npmjs.org/...'}`
//       on every non-workspace node. The cross-format stringifier emits the
//       yarn-berry PM-native locator (`<name>@npm:<version>`) verbatim into
//       the npm-3 `resolved:` field; the npm-3 parser cannot recognise this
//       as a registry URL and falls back к `{type: 'unknown', raw:
//       '<name>@npm:<version>'}`. Canonical type degrades `tarball ->
//       unknown` on every tarball-bearing node. Distinct from yb9 <-> pnpm-v9
//       case where the resolved-url drop is subsumed under workspace-rekey's
//       rationale; here it stands alone (workspace identity aligns across
//       yb9 / npm-3 via the shared `<name>@0.0.0-use.local` convention).
//     - All other PreservedFeatures round-trip: workspace identity matches
//       (`<name>@0.0.0-use.local` on both sides), no peer-virt on yb9
//       sources, no patch / conditions / cacheKey-as-graph-shape concerns.
//       Integrity preserved (canonical SRI). Tarballs preserved (yb9
//       sources don't carry engines / funding extras, so the sidecar-bridge
//       gap doesn't fire — distinct от npm-3 -> yb9 direction below).
//
//   npm-3 -> yarn-berry-v9 (REVERSE, asymmetric):
//     - `tarballs` drops on 4/6 fixtures (deps-with-scopes, peers-basic,
//       peers-multi, yarn-crlf): TarballPayload extras (`engines`, `funding`)
//       drop across the cross-family boundary. npm-3 holds them in the
//       per-graph npm sidecar (`_npm-core.ts`), yarn-berry-v9 holds tarball
//       extras in `_yarn-berry-core.ts` sidecar. The shared `tarballPayloadOf`
//       populates `TarballPayload.engines` etc on parse, but the yarn-berry-v9
//       stringifier emits engines only via the per-version sidecar (no
//       fallback to `tarball.engines`), so they drop on emit. Mirrors the
//       Phase B / Phase C-i sidecar-bridge pattern.
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally: yarn-
//       berry destinations always synthesise a `__metadata` block (version
//       + cacheKey) absent from npm-3 sources. Mirrors the classic->berry +
//       pnpm-v9->yb9 precedent.
//     - `resolved-url` does NOT drop on REVERSE direction: npm-3 source
//       carries a tarball URL in `resolved:`, yarn-berry-v9 stringifier
//       writes the canonical `<name>@npm:<version>` locator which the yb9
//       parser re-translates to canonical type `tarball`. Type matches.
//     - Graph nodes/edges round-trip cleanly across all 6 fixtures incl.
//       peers-multi (npm-3 source already has placement hints).
//     - Reentrancy `asymmetric` (precedent-aligned with all other cross-
//       family contracts; tarball extras don't round-trip).
function buildCrossFamilyYb9ToNpm3(): ConversionContract {
  return {
    from: 'yarn-berry-v9',
    to:   'npm-3',
    preserved: withoutFeatures('resolved-url'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_3_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'yarn-berry-v9 stringifier emits the PM-native locator `<name>@npm:<version>` into the npm-3 `resolved:` field; the npm-3 parser cannot translate this back to a registry tarball URL и canonical `tarball.resolution.type` degrades `tarball -> unknown` (raw locator preserved as attribution). Distinct from yb9 <-> pnpm-v9 case where the resolved-url drop is subsumed under workspace-rekey; here it stands alone because workspace identity aligns (yb9 + npm-3 both use `<name>@0.0.0-use.local` for workspace members). Fires on every non-workspace tarball-bearing node across the 6-fixture corpus.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_NPM3_FIXTURES],
  }
}

function buildCrossFamilyNpm3ToYb9(): ConversionContract {
  return {
    from: 'npm-3',
    to:   'yarn-berry-v9',
    preserved: withoutFeatures('tarballs'),
    lost: [
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_BERRY_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'TarballPayload extras (`engines`, `funding`) drop across the cross-family boundary — npm-3 holds them in the per-graph npm sidecar (`_npm-core.ts`) distinct from yarn-berry-v9 per-graph sidecars (`_yarn-berry-core.ts`), mirroring the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i yb9 <-> pnpm-v9 bridge gap. Shared `tarballPayloadOf` populates `TarballPayload.engines` on parse, but yarn-berry-v9 stringify emits via the per-version sidecar without falling back to `tarball.engines`. Fires on deps-with-scopes (`@sindresorhus/is@6.3.1`: engines + funding), peers-basic (`react@18.2.0`: engines), peers-multi (object-assign, react@17, react@18: engines), yarn-crlf (`is-buffer@2.0.5`: engines + funding). simple / workspaces-basic carry no tarball extras so the loss does not fire.',
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry destinations always synthesise a `__metadata` preamble (version + cacheKey) absent from npm-3 sources; mirrors the classic->berry and pnpm-v9->yb9 precedent.',
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_NPM3_FIXTURES],
  }
}

const CROSS_FAMILY_YB9_NPM3_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyYb9ToNpm3(),
  buildCrossFamilyNpm3ToYb9(),
]

// === cross-family yarn-berry-v4 <-> npm-3 (ADR-0020 Phase E-i) ==============
//
// Older-berry expansion of the yb9 <-> npm-3 pair. Probe confirmed:
//
//   yarn-berry-v4 -> npm-3 (FORWARD, asymmetric):
//     - `resolved-url` drops universally across the 7-fixture corpus, now
//       INCLUDING `git-github-tarball`. The npm-3 `resolved:` field receives
//       the yarn-berry PM-native `<name>@<locator>` envelope verbatim; npm-3
//       reparses it as `resolution.type = unknown`, so canonical `tarball` and
//       `git` resolutions both degrade to `unknown`.
//     - Workspace identity still aligns (`<name>@0.0.0-use.local` on both
//       sides), so this loss stands alone rather than being subsumed under a
//       workspace-rekey contract entry.
//     - No v4-specific conditions loss exists because the source format cannot
//       encode `conditions` in the first place.
//
//   npm-3 -> yarn-berry-v4 (REVERSE, asymmetric):
//     - `tarballs` drops on 5/7 fixtures: deps-with-scopes, git-github-tarball,
//       peers-basic, peers-multi, yarn-crlf. This is the same sidecar-bridge
//       pattern as npm-3 -> yb9, but the git fixture widens the firing set:
//       v4 emit drops `engines` / `funding` on registry deps and also `license`
//       on the git/tarball payloads carried only by that fixture.
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally with the
//       v4 handshake literal `4`.
//     - `resolved-url` round-trips cleanly in reverse: npm-3's canonical
//       tarball/git URLs survive yb-v4 parse after stringify.
function buildCrossFamilyYb4ToNpm3(): ConversionContract {
  return {
    from: 'yarn-berry-v4',
    to:   'npm-3',
    preserved: withoutFeatures('resolved-url'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_NPM_3_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'yarn-berry-v4 stringifier emits the PM-native `<name>@<locator>` envelope into npm-3 `resolved:` fields; the npm-3 parser cannot translate that back to canonical registry/git resolution, so `tarball.resolution.type` and `git.resolution.type` degrade to `unknown` (raw locator preserved as attribution). Distinct from yb4 <-> pnpm-v9 where the apparent resolved-url loss is subsumed under workspace-rekey; here workspace identity aligns (yb4 + npm-3 both use `<name>@0.0.0-use.local` for workspace members). Fires on every tarball-/git-bearing node across the 7-fixture corpus, including `git-github-tarball`.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB4_NPM3_FIXTURES],
  }
}

function buildCrossFamilyNpm3ToYb4(): ConversionContract {
  return {
    from: 'npm-3',
    to:   'yarn-berry-v4',
    preserved: withoutFeatures('tarballs'),
    lost: [
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_BERRY_V4_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'TarballPayload extras drop across the cross-family boundary — npm-3 holds them in the per-graph npm sidecar (`_npm-core.ts`) distinct from yarn-berry-v4 per-graph sidecars (`_yarn-berry-core.ts`), mirroring the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i/C-iii bridge gaps. Shared `tarballPayloadOf` populates `engines`, `funding`, and `license` on parse, but yarn-berry-v4 stringify emits via the per-version sidecar without falling back to `tarball.*`. Fires on deps-with-scopes (`@sindresorhus/is@6.3.1`: engines + funding), git-github-tarball (`@sindresorhus/is@6.3.1`: engines + funding + license; `ms@2.1.3`: license), peers-basic (`react@18.2.0`: engines), peers-multi (object-assign, react@17, react@18: engines), and yarn-crlf (`is-buffer@2.0.5`: engines + funding). simple / workspaces-basic carry no tarball extras so the loss does not fire.',
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_BERRY_V4_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry-v4 destinations always synthesise a `__metadata` preamble (version literal `4`, optional cacheKey) absent from npm-3 sources; mirrors the classic->berry and pnpm-v9->yb* precedents with the v4 handshake value.',
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB4_NPM3_FIXTURES],
  }
}

const CROSS_FAMILY_YB4_NPM3_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyYb4ToNpm3(),
  buildCrossFamilyNpm3ToYb4(),
]

// === cross-family yarn-berry-v{5,6,8} <-> npm-3 (ADR-0020 Phase E-ii) =======
//
// Probe matched the existing yb4 cross-family npm shape across the shared
// 7-fixture corpus:
//
//   yarn-berry-v{5,6,8} -> npm-3 (FORWARD, asymmetric):
//     - `resolved-url` drops universally, including `git-github-tarball`.
//       npm-3 receives the yarn-berry PM-native `<name>@<locator>` envelope
//       verbatim in `resolved:` and reparses it as canonical `unknown`, so
//       both registry-tarball and git resolutions degrade to `unknown`.
//     - Workspace identity still aligns (`<name>@0.0.0-use.local` on both
//       sides), so the loss stands alone rather than being subsumed under a
//       workspace-rekey contract entry.
//
//   npm-3 -> yarn-berry-v{5,6,8} (REVERSE, asymmetric):
//     - `tarballs` drops on 5/7 fixtures: deps-with-scopes, git-github-tarball,
//       peers-basic, peers-multi, yarn-crlf. Same sidecar-bridge pattern as
//       npm-3 -> yb4 / yb9: registry deps lose `engines` / `funding`, and the
//       git fixture widens the firing set with `license` on git/tarball payloads.
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally with the
//       destination handshake literal `5`, `6`, or `8`.
//
// No mid-only delta surfaced here either: conditions support exists from v5+,
// but no shared fixture exercises it; checksum encoding differences stay at the
// adapter boundary and do not change the graph-level contract.
function buildCrossFamilyYbMidToNpm3(version: MidBerryVersion): ConversionContract {
  const from = midBerryFormat(version)
  return {
    from,
    to:   'npm-3',
    preserved: withoutFeatures('resolved-url'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: `INTEROP_${fromCode(from)}_TO_NPM_3_RESOLVED_URL_DROPPED`,
        severity:   'warning',
        rationale:  `yarn-berry-v${version} stringifier emits the PM-native \`<name>@<locator>\` envelope into npm-3 \`resolved:\` fields; the npm-3 parser cannot translate that back to canonical registry/git resolution, so \`tarball.resolution.type\` and \`git.resolution.type\` degrade to \`unknown\` (raw locator preserved as attribution). Distinct from yb-v${version} <-> pnpm-v9 where the apparent resolved-url loss is subsumed under workspace-rekey; here workspace identity aligns (yb-v${version} + npm-3 both use \`<name>@0.0.0-use.local\` for workspace members). Fires on every tarball-/git-bearing node across the 7-fixture corpus, including \`git-github-tarball\`.`,
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB_MID_NPM3_FIXTURES],
  }
}

function buildCrossFamilyNpm3ToYbMid(version: MidBerryVersion): ConversionContract {
  const to = midBerryFormat(version)
  return {
    from: 'npm-3',
    to,
    preserved: withoutFeatures('tarballs'),
    lost: [
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_NPM_3_TO_${fromCode(to)}_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `TarballPayload extras drop across the cross-family boundary — npm-3 holds them in the per-graph npm sidecar (\`_npm-core.ts\`) distinct from yarn-berry-v${version} per-graph sidecars (\`_yarn-berry-core.ts\`), mirroring the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i/C-iii bridge gaps. Shared \`tarballPayloadOf\` populates \`engines\`, \`funding\`, and \`license\` on parse, but yarn-berry-v${version} stringify emits via the per-version sidecar without falling back to \`tarball.*\`. Fires on deps-with-scopes (\`@sindresorhus/is@6.3.1\`: engines + funding), git-github-tarball (\`@sindresorhus/is@6.3.1\`: engines + funding + license; \`ms@2.1.3\`: license), peers-basic (\`react@18.2.0\`: engines), peers-multi (object-assign, react@17, react@18: engines), and yarn-crlf (\`is-buffer@2.0.5\`: engines + funding). simple / workspaces-basic carry no tarball extras so the loss does not fire.`,
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: `INTEROP_NPM_3_TO_${fromCode(to)}_PREAMBLE_SYNTHESIZED`,
        severity:   'info',
        rationale:  `yarn-berry-v${version} destinations always synthesise a \`__metadata\` preamble (version literal \`${version}\`, optional cacheKey) absent from npm-3 sources; mirrors the classic->berry and pnpm-v9->yb* precedents with the mid-berry handshake value.`,
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB_MID_NPM3_FIXTURES],
  }
}

const CROSS_FAMILY_YB_MID_NPM3_CONTRACTS: ConversionContract[] = MID_BERRY_VERSIONS.flatMap(
  version => [
    buildCrossFamilyYbMidToNpm3(version),
    buildCrossFamilyNpm3ToYbMid(version),
  ],
)

// === cross-family pnpm-v9 <-> npm-3 (ADR-0020 Phase C-iv) ===================
//
// Closes the 3-major-family ring (yarn-berry × pnpm × npm). Empirically-probed
// loss profile across CROSS_FAMILY_PNPM9_NPM3_FIXTURES:
//
//   pnpm-v9 -> npm-3 (FORWARD, asymmetric):
//     - `peer-virt` drops on `peers-basic`: pnpm-v9 source carries the
//       parenthesized identity `react-dom@18.2.0(react@18.2.0)`; npm-3
//       stringify flattens it via `NPM_V3_PEER_VIRT_FLATTENED` (per
//       ADR-0021 §A.npm-3 — npm has no parenthesized peer-context
//       namespace), collapsing the NodeId to bare `react-dom@18.2.0`.
//       Source nodes / edges / edge-kinds / integrity / resolved-url tied
//       to the parenthesized NodeId become unreachable in destination by id
//       (mirrors Phase C-ii pnpm-v9 -> yarn-berry-v9 peer-virt cascade).
//       Distinct from yb9 -> pnpm-v9 case which fires `workspace-rekey`:
//       in this forward direction workspace identity ALIGNS (pnpm-v9
//       source uses `.@<version>` root + path-keyed members which npm-3
//       round-trips by id).
//     - `tarballs` PRESERVED: pnpm-v9 sources don't carry sidecar-gated
//       tarball extras the npm-3 destination cannot store (engines /
//       funding live на `tarball.engines`/`tarball.funding` fallback paths;
//       no sidecar-bridge gap fires across the 5-fixture corpus). Distinct
//       from npm-3 -> pnpm-v9 reverse direction below.
//
//   npm-3 -> pnpm-v9 (REVERSE, asymmetric):
//     - `workspace-rekey` UNIVERSAL across the 6-fixture corpus. npm-3
//       stamps workspace identity by package name (root =
//       `<pkg-name>@<version>` from package.json, members =
//       `<pkg-name>@<version>` from member package.json), pnpm-v9 stamps
//       по path (root = `.@<version>`, members =
//       `<workspacePath>@<version>`). Mirrors yb9 -> pnpm-v9 Phase C-i
//       rationale: identity-convention mismatch — same workspace graph,
//       two NodeId shapes → source workspace nodes (root + members) not
//       preserved by id in destination и outgoing edges from those nodes
//       appear orphaned to the comparator. Subsumes graph-shape drops
//       `nodes` / `edges` / `edge-kinds` / `workspace-membership`. NB:
//       distinct from FORWARD direction где workspace identity aligns —
//       the asymmetry arises because pnpm-v9 stringify is name-agnostic
//       (uses workspacePath as ground truth) but npm-3 stringify carries
//       the package name verbatim из manifest; round-tripping npm-3 ->
//       pnpm-v9 -> npm-3 loses the original package-name identity.
//     - `tarballs` drops on 4/6 fixtures (deps-with-scopes, peers-basic,
//       peers-multi, yarn-crlf): sidecar-bridge gap mirroring Phase B / C-i
//       / C-iii. npm-3 holds extras in the per-graph npm sidecar
//       (`_npm-core.ts`), pnpm-v9 в the flat-core WeakMap
//       (`_pnpm-flat-core.ts`). Shared `tarballPayloadOf` populates
//       `TarballPayload.engines` / `funding` / `bin` on parse, но pnpm-v9
//       stringify emits via the per-version sidecar without falling back
//       to `tarball.*` so they drop on emit. Fires on `funding` (deps-with-
//       scopes `@sindresorhus/is@6.3.1`, yarn-crlf `is-buffer@2.0.5`) и
//       on `bin` (peers-basic / peers-multi `loose-envify@1.4.0`). simple /
//       workspaces-basic carry no tarball extras so the loss does not fire.
//     - `peer-virt` does NOT drop on REVERSE: npm-3 source has no
//       peer-virt to begin with (npm flattens peer-context on parse via
//       `NPM_V3_PEER_VIRT_FLATTENED`), so nothing to lose. `resolved-url`
//       does NOT degrade (npm-3 tarball URLs round-trip cleanly through
//       pnpm-v9 — non-workspace NodeIds align by id).
//     - peers-multi included в REVERSE corpus: npm-3 source carries
//       hoist placement hints, so pnpm-v9 reparses the multi-version stack
//       без collapse (distinct от FORWARD direction).
function buildCrossFamilyPnpm9ToNpm3(): ConversionContract {
  return {
    from: 'pnpm-v9',
    to:   'npm-3',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_NPM_3_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'npm-3 stringify flattens peer-virt NodeIds via `NPM_V3_PEER_VIRT_FLATTENED` (ADR-0021 §A.npm-3 — npm has no parenthesized peer-context namespace): source `<name>@<version>(<peer-ctx>)` collapses to bare `<name>@<version>` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic). Mirrors Phase C-ii pnpm-v9 -> yarn-berry-v9 peer-virt cascade.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_PNPM9_NPM3_FIXTURES],
  }
}

function buildCrossFamilyNpm3ToPnpm9(): ConversionContract {
  return {
    from: 'npm-3',
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_NPM_3_TO_PNPM_V9_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'npm-3 stamps workspace identity by package name (root = `<pkg-name>@<version>` from root package.json, members = `<pkg-name>@<version>` from member package.json); pnpm-v9 stamps by path (root = `.@<version>`, members = `<workspacePath>@<version>`). Same workspace graph, two NodeId conventions → source workspace nodes (incl. root) not preserved by id in destination, и outgoing edges from those nodes appear orphaned to the comparator. Subsumes graph-shape drops `nodes` / `edges` / `edge-kinds` / `workspace-membership`. Mirrors Phase C-i yb9 -> pnpm-v9 workspace-rekey rationale.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_3_TO_PNPM_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'TarballPayload extras (`bin`, `funding`) drop across the cross-family boundary — npm-3 holds them in the per-graph npm sidecar (`_npm-core.ts`) distinct from pnpm-v9 flat-core WeakMap (`_pnpm-flat-core.ts`), mirroring the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i yb9 <-> pnpm-v9 sidecar-bridge gap. Shared `tarballPayloadOf` populates `TarballPayload.bin` / `funding` on parse, но pnpm-v9 stringify emits via the per-version sidecar without falling back to `tarball.*`. Fires on `funding` (deps-with-scopes `@sindresorhus/is@6.3.1`, yarn-crlf `is-buffer@2.0.5`) и `bin` (peers-basic / peers-multi `loose-envify@1.4.0`). `engines` is preserved on both sides via the `tarball.engines` fallback path (not sidecar-gated). simple / workspaces-basic carry no sidecar-gated extras so the loss does not fire.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_PNPM9_NPM3_FIXTURES],
  }
}

const CROSS_FAMILY_PNPM9_NPM3_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyPnpm9ToNpm3(),
  buildCrossFamilyNpm3ToPnpm9(),
]

// === cross-family pnpm-v{5,6} <-> npm-3 (ADR-0020 Phase E-iv) ==============
//
// Probe target mirrors the modern pnpm-v9 <-> npm-3 ring on the same shared
// six-fixture disk intersection, with the only substantive delta being the v5
// sidecar boundary on the reverse tarball-loss path:
//
//   pnpm-v{5,6} -> npm-3 (FORWARD, asymmetric):
//     - `peer-virt` drops on peers-basic / peers-multi exactly as on
//       pnpm-v9 -> npm-3. npm-3 cannot preserve parenthesized peer-context ids,
//       so the loss subsumes `nodes` / `edges` / `edge-kinds` / `integrity` /
//       `resolved-url` on peer fixtures.
//
//   npm-3 -> pnpm-v{5,6} (REVERSE, asymmetric):
//     - `workspace-rekey` remains universal: npm-3 names workspace nodes while
//       both older pnpm generations key them by path.
//     - `tarballs` drops on deps-with-scopes / peers-basic / peers-multi /
//       yarn-crlf. v5 loses them across the npm-sidecar -> v5-private-sidecar
//       bridge; v6 matches the npm-sidecar -> flat-core pattern already pinned
//       for pnpm-v9.
const OLDER_PNPM_NPM3_FIXTURES: Record<OlderPnpmFormat, readonly string[]> = {
  'pnpm-v5': CROSS_FAMILY_PNPM5_NPM3_FIXTURES,
  'pnpm-v6': CROSS_FAMILY_PNPM6_NPM3_FIXTURES,
}

function buildCrossFamilyOlderPnpmToNpm3(from: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[from]
  return {
    from,
    to:   'npm-3',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: `INTEROP_${fromCode(from)}_TO_NPM_3_PEER_VIRT_DROPPED`,
        severity:   'warning',
        rationale:  `npm-3 stringify flattens peer-virt NodeIds via \`NPM_V3_PEER_VIRT_FLATTENED\` (ADR-0021 §A.npm-3): pnpm-v${version} source \`<name>@<version>(<peer-ctx>)\` collapses to bare \`<name>@<version>\` in destination. Source nodes / edges / edge-kinds / integrity / resolved-url tied to the parenthesized NodeId become unreachable in destination by id — peer-virt loss subsumes those graph-shape drops on peer-virt-bearing fixtures (peers-basic, peers-multi).`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_PNPM_NPM3_FIXTURES[from]],
  }
}

function buildCrossFamilyNpm3ToOlderPnpm(to: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[to]
  const targetSidecar = to === 'pnpm-v5'
    ? 'the pnpm-v5 private node sidecar in `pnpm-v5.ts`'
    : 'the pnpm-v6 flat-core WeakMap (`_pnpm-flat-core.ts`)'
  return {
    from: 'npm-3',
    to,
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: `INTEROP_NPM_3_TO_${fromCode(to)}_WORKSPACE_REKEY`,
        severity:   'warning',
        rationale:  `npm-3 stamps workspace identity by package name (root = \`<pkg-name>@<version>\`, members = \`<pkg-name>@<version>\` from package.json), while pnpm-v${version} stamps by path (root = \`.@<version>\`, members = \`<workspacePath>@<version>\`). Same workspace graph, two NodeId conventions -> source workspace nodes (incl. root) not preserved by id in destination, and outgoing edges from those nodes appear orphaned to the comparator. Subsumes graph-shape drops \`nodes\` / \`edges\` / \`edge-kinds\` / \`workspace-membership\`.`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_NPM_3_TO_${fromCode(to)}_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `TarballPayload extras (\`bin\`, \`funding\`) drop across the cross-family boundary — npm-3 holds them in the per-graph npm sidecar (\`_npm-core.ts\`) distinct from ${targetSidecar}, mirroring the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i yb9 <-> pnpm-v9 bridge gaps. Probe target covers \`funding\` (deps-with-scopes \`@sindresorhus/is@6.3.1\`, yarn-crlf \`is-buffer@2.0.5\`) and \`bin\` (peers-basic / peers-multi \`loose-envify@1.4.0\`). \`engines\` stays preserved via the shared \`tarball.engines\` fallback path.`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_PNPM_NPM3_FIXTURES[to]],
  }
}

const CROSS_FAMILY_OLDER_PNPM_NPM3_CONTRACTS: ConversionContract[] = OLDER_PNPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderPnpmToNpm3(format),
    buildCrossFamilyNpm3ToOlderPnpm(format),
  ],
)

// === cross-family yarn-classic <-> pnpm-v9 (ADR-0020 Phase D-i) ============
//
// Empirically-probed loss profile:
//
//   yarn-classic -> pnpm-v9 (FORWARD, asymmetric):
//     - Honest corpus = CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES (5 fixtures).
//       `workspaces-basic` is EXCLUDED: the naive yarn-classic source lockfile
//       carries only the external `ms@2.1.3` entry on disk (no root/member
//       workspace nodes per ADR-0019 §C), so pnpm-v9 stringify synthesises
//       only the importer root (`.@0.0.0`) and drops the external node
//       entirely. That is an incomplete-source artifact, not the pair's
//       steady-state graph-loss profile.
//     - Across the honest 5-fixture corpus, graph state is fully preserved:
//       canonical integrity survives, canonical resolution type survives, and
//       no patch / peer-virt / workspace feature is present on the source side
//       to lose. No INTEROP_* diagnostics fire on the corpus.
//
//   pnpm-v9 -> yarn-classic (REVERSE, asymmetric):
//     - Corpus = CROSS_FAMILY_PNPM9_CLASSIC_FIXTURES (shared 6-fixture set
//       plus `patch-yarn`; `workspace-cross-refs` excluded in _fixtures.ts due
//       to a distinct classic-side missing-entry blocker).
//     - `workspace-metadata` drops UNIVERSALLY. pnpm-v9 sources carry
//       `workspacePath` on the root node (`''`) for every fixture and on
//       member nodes for workspace fixtures; yarn-classic reparses the same
//       ids but without `workspacePath` / `attrs.workspace` bookkeeping.
//       Same NodeIds survive, metadata does not. Mirrors the berry -> classic
//       downgrade shape, but the pnpm side uses path-keyed workspace metadata.
//     - `peer-virt` fires on peers-basic / peers-multi. classic has no
//       peer-context namespace, so `react-dom@18.2.0(react@18.2.0)` and the
//       multi-stack analogues flatten to bare ids; source nodes / edges /
//       edge-kinds / integrity / resolved-url tied to the parenthesized ids
//       are no longer reachable by id in destination.
//     - `patch` fires on patch-yarn. classic has no patch primitive; the
//       patched `lodash@4.17.21+patch=unresolved-...` node loses its patch
//       slot on emit, matching the adapter-layer `RECIPE_FEATURE_DROPPED`.
//     - `tarballs` fires on deps-with-scopes / yarn-crlf / patch-yarn. The
//       cross-family boundary drops sidecar-gated tarball extras (`engines` on
//       `@sindresorhus/is` / `is-buffer`) and the patched node's tarball entry
//       disappears entirely once classic drops the patch slot.
function buildCrossFamilyClassicToPnpm9(): ConversionContract {
  return {
    from: 'yarn-classic',
    to:   'pnpm-v9',
    preserved: ALL_FEATURES,
    lost:        [],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES],
  }
}

function buildCrossFamilyPnpm9ToClassic(): ConversionContract {
  return {
    from: 'pnpm-v9',
    to:   'yarn-classic',
    preserved: withoutFeatures(
      'nodes',
      'edges',
      'edge-kinds',
      'integrity',
      'resolved-url',
      'tarballs',
      'workspace-membership',
      'patch-slots',
      'peer-virt',
    ),
    lost: [
      {
        feature:    'workspace-metadata',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity:   'info',
        rationale:  'pnpm-v9 sources carry `workspacePath` on the root node for every fixture (and on member nodes for workspace fixtures); yarn-classic reparses the same NodeIds without `workspacePath` / `attrs.workspace` bookkeeping. The workspace graph survives by id, but workspace metadata does not.',
      },
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'classic has no peer-context namespace. pnpm-v9 source nodes such as `react-dom@18.2.0(react@18.2.0)` flatten to bare ids on stringify+parse (`YARN_CLASSIC_PEER_VIRT_FLATTENED` / `YARN_CLASSIC_PEER_DROPPED` at the adapter layer), so the peer-virtualized node id and its outgoing edges are no longer reachable by id in destination. Fires on peers-basic / peers-multi and subsumes the associated `nodes` / `edges` / `edge-kinds` / `integrity` / `resolved-url` subset failures.',
      },
      {
        feature:    'patch',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity:   'warning',
        rationale:  'classic has no patch primitive. The patch-bearing `lodash@4.17.21+patch=unresolved-...` node in patch-yarn loses its patch slot on emit, matching the adapter-layer `RECIPE_FEATURE_DROPPED` path.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_PNPM_V9_TO_YARN_CLASSIC_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'Tarball payloads diverge across the reverse boundary: sidecar-gated extras (`engines`) drop on deps-with-scopes / yarn-crlf because pnpm-v9 stores them in `_pnpm-flat-core.ts` graph sidecars that classic stringify does not consult, and the patch-yarn fixture loses the patched node tarball entry entirely once classic drops the patch slot.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_PNPM9_CLASSIC_FIXTURES],
  }
}

const CROSS_FAMILY_CLASSIC_PNPM9_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyClassicToPnpm9(),
  buildCrossFamilyPnpm9ToClassic(),
]

// === cross-family yarn-classic <-> pnpm-v{5,6} (ADR-0020 Phase E-iv) =======
//
// Older-pnpm expansion of the classic <-> pnpm-v9 pair. Probe target keeps
// the same honest classic-source narrowing and the same reverse-only
// workspace-cross-refs blocker on the classic destination. Version deltas:
// v5 has no patch primitive or patch-bearing fixture; v6 matches the pnpm-v9
// reverse patch-loss path on `patch-yarn`.
const CLASSIC_OLDER_PNPM_FIXTURES: Record<OlderPnpmFormat, readonly string[]> = {
  'pnpm-v5': CROSS_FAMILY_CLASSIC_PNPM5_FIXTURES,
  'pnpm-v6': CROSS_FAMILY_CLASSIC_PNPM6_FIXTURES,
}

const OLDER_PNPM_CLASSIC_FIXTURES: Record<OlderPnpmFormat, readonly string[]> = {
  'pnpm-v5': CROSS_FAMILY_PNPM5_CLASSIC_FIXTURES,
  'pnpm-v6': CROSS_FAMILY_PNPM6_CLASSIC_FIXTURES,
}

function buildCrossFamilyClassicToOlderPnpm(to: OlderPnpmFormat): ConversionContract {
  return {
    from: 'yarn-classic',
    to,
    preserved: ALL_FEATURES,
    lost:        [],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CLASSIC_OLDER_PNPM_FIXTURES[to]],
  }
}

function buildCrossFamilyOlderPnpmToClassic(from: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[from]
  const preservedDrop: PreservedFeature[] = [
    'nodes',
    'edges',
    'edge-kinds',
    'integrity',
    'resolved-url',
    'tarballs',
    'workspace-membership',
    'peer-virt',
  ]
  if (from === 'pnpm-v6') preservedDrop.push('patch-slots')

  const lost: LossEntry[] = [
    {
      feature:    'workspace-metadata',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED`,
      severity:   'info',
      rationale:  `pnpm-v${version} sources carry \`workspacePath\` on the root node for every fixture (and on member nodes for workspace fixtures); yarn-classic reparses the same NodeIds without \`workspacePath\` / \`attrs.workspace\` bookkeeping. The workspace graph survives by id, but workspace metadata does not.`,
    },
    {
      feature:    'peer-virt',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_PEER_VIRT_DROPPED`,
      severity:   'warning',
      rationale:  `classic has no peer-context namespace. pnpm-v${version} source nodes such as \`react-dom@18.2.0(react@18.2.0)\` flatten to bare ids on stringify+parse, so the peer-virtualized node id and its outgoing edges are no longer reachable by id in destination. Fires on peers-basic / peers-multi and subsumes the associated \`nodes\` / \`edges\` / \`edge-kinds\` / \`integrity\` / \`resolved-url\` subset failures.`,
    },
    {
      feature:    'tarballs',
      diagnostic: `INTEROP_${fromCode(from)}_TO_YARN_CLASSIC_TARBALLS_DROPPED`,
      severity:   'warning',
      rationale:  from === 'pnpm-v5'
        ? 'Tarball payloads diverge across the reverse boundary: pnpm-v5 stores sidecar-gated extras (`engines`, `hasBin`) in its private graph sidecar, while classic stringify only emits integrity + resolved URL from the graph. Probe target covers `engines` loss on deps-with-scopes / yarn-crlf and `bin` loss on peers-basic / peers-multi.'
        : 'Tarball payloads diverge across the reverse boundary: sidecar-gated extras (`engines`) drop on deps-with-scopes / yarn-crlf because pnpm-v6 stores them in `_pnpm-flat-core.ts` graph sidecars that classic stringify does not consult, and the patch-yarn fixture loses the patched node tarball entry entirely once classic drops the patch slot.',
    },
  ]

  if (from === 'pnpm-v6') {
    lost.splice(2, 0, {
      feature:    'patch',
      diagnostic: 'INTEROP_PNPM_V6_TO_YARN_CLASSIC_PATCH_DROPPED',
      severity:   'warning',
      rationale:  'classic has no patch primitive. The patch-bearing `lodash@4.17.21+patch=unresolved-...` node in patch-yarn loses its patch slot on emit, matching the adapter-layer `RECIPE_FEATURE_DROPPED` path already observed on pnpm-v9 -> yarn-classic.',
    })
  }

  return {
    from,
    to:   'yarn-classic',
    preserved: withoutFeatures(...preservedDrop),
    lost,
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_PNPM_CLASSIC_FIXTURES[from]],
  }
}

const CROSS_FAMILY_CLASSIC_OLDER_PNPM_CONTRACTS: ConversionContract[] = OLDER_PNPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyClassicToOlderPnpm(format),
    buildCrossFamilyOlderPnpmToClassic(format),
  ],
)

// === cross-family yarn-classic <-> npm-3 (ADR-0020 Phase D-ii) =============
//
// Empirically-probed loss profile:
//
//   yarn-classic -> npm-3 (FORWARD, asymmetric):
//     - Honest corpus = CROSS_FAMILY_CLASSIC_NPM3_FIXTURES (6 fixtures).
//       `workspaces-basic` is EXCLUDED too: the naive classic source lockfile
//       carries only the external `ms@2.1.3` entry on disk, so npm-3
//       reparses that lone node as the root package and drops its tarball
//       payload. That is an incomplete-source artifact, not the steady-state
//       pair profile.
//     - Across the honest 6-fixture corpus, graph state is fully preserved:
//       canonical integrity survives, canonical resolution survives, workspace
//       identity does not need rekeying, and no patch / peer-virt / classic
//       multi-spec collapse is present on the source side. No INTEROP_*
//       diagnostics fire on the corpus.
//
//   npm-3 -> yarn-classic (REVERSE, asymmetric):
//     - Honest corpus = CROSS_FAMILY_NPM3_CLASSIC_FIXTURES (6 fixtures).
//       `git-github-tarball` is EXCLUDED: classic stringify emits the
//       npm-derived git payload as `resolved "ssh://git@github.com/...#<sha>"`
//       and the classic parser rejects that URL form with
//       `PARSE_FAILED unsupported resolved URL`. Adapter-layer handshake bug;
//       out of this dispatch's scope per the guard.
//     - `workspace-metadata` drops UNIVERSALLY on the honest corpus. npm-3
//       sources stamp the root node with `workspacePath: ''` for every
//       fixture (and workspace fixtures additionally carry member
//       `workspacePath` + `attrs.workspace` edges); classic reparses the same
//       ids but omits that bookkeeping.
//     - `tarballs` drops on deps-with-scopes / peers-basic / peers-multi /
//       yarn-crlf. npm-3 stores tarball extras in the per-graph npm sidecar
//       (`_npm-core.ts`), while classic stringify only emits integrity +
//       resolved URL. Probe confirms `engines` / `funding` drop on
//       `@sindresorhus/is@6.3.1` and `is-buffer@2.0.5`, plus `bin` and
//       additional `engines` drops in the peer fixtures
//       (`loose-envify@1.4.0`, `react@18.2.0`, `object-assign@4.1.1`,
//       `react@17.0.2`).
function buildCrossFamilyClassicToNpm3(): ConversionContract {
  return {
    from: 'yarn-classic',
    to:   'npm-3',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_CLASSIC_NPM3_FIXTURES],
  }
}

function buildCrossFamilyNpm3ToClassic(): ConversionContract {
  return {
    from: 'npm-3',
    to:   'yarn-classic',
    preserved: withoutFeatures('tarballs', 'workspace-membership'),
    lost: [
      {
        feature:    'workspace-metadata',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity:   'info',
        rationale:  'npm-3 sources stamp the root node with `workspacePath: \'\'` on every fixture (and workspace fixtures additionally carry member `workspacePath` + `attrs.workspace` edges); yarn-classic reparses the same NodeIds without `workspacePath` / `attrs.workspace` bookkeeping. The graph survives by id, but workspace metadata does not.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_3_TO_YARN_CLASSIC_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'Tarball payload extras drop across the reverse boundary — npm-3 keeps `engines`, `funding`, and `bin` in the per-graph npm sidecar (`_npm-core.ts`), while classic stringify emits only integrity + resolved URL from the graph. Probe confirmed losses on deps-with-scopes (`@sindresorhus/is@6.3.1`: engines + funding), peers-basic / peers-multi (`loose-envify@1.4.0`: bin; `react@18.2.0`, `object-assign@4.1.1`, `react@17.0.2`: engines), and yarn-crlf (`is-buffer@2.0.5`: engines + funding). simple / workspaces-basic carry no extra tarball fields so the loss does not fire there.',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_NPM3_CLASSIC_FIXTURES],
  }
}

const CROSS_FAMILY_CLASSIC_NPM3_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyClassicToNpm3(),
  buildCrossFamilyNpm3ToClassic(),
]

// === cross-family yarn-classic <-> bun-text (ADR-0020 Phase D-iii) ==========
//
// Empirically-probed loss profile across CROSS_FAMILY_CLASSIC_BUN_FIXTURES
// (the 6-fixture yarn-classic ∩ bun-text disk intersection):
//
//   yarn-classic -> bun-text (FORWARD, asymmetric):
//     - Honest corpus = 4 fixtures (deps-with-scopes, peers-basic, simple,
//       yarn-crlf). `workspaces-basic` is EXCLUDED: the naive yarn-classic
//       source lockfile carries only `ms@2.1.3` on disk (no root/member
//       workspace nodes per ADR-0019 §C), so bun-text reparses that lone node
//       as the synthetic workspace root `ms@2.1.3` and drops its tarball
//       payload entirely. Incomplete-source artifact, not the steady-state
//       pair profile. `peers-multi` is EXCLUDED too: bun-text reparses
//       `react-dom@18.2.0`'s outgoing `scheduler` edge onto
//       `scheduler@0.20.2` instead of the source-declared `scheduler@0.23.2`
//       when fed a classic-shaped multi-version source graph. Consumer-scope
//       resolution / de-hoist reconstruction blocker on the bun side, not an
//       honest cross-family loss.
//     - `resolved-url` fires universally on the honest corpus. yarn-classic
//       source tarballs carry canonical `{type: 'tarball', url}` resolution
//       payloads via `resolved:`; bun-text emits regular packages as
//       positional tuples `[<id>, "", <inner>, "<integrity>"]` with no URL
//       slot, so the canonical resolution degrades to `undefined` on every
//       non-workspace tarball-bearing node.
//     - No `workspace-rekey`: unlike yb9 -> bun-text, the naive classic source
//       graph carries no workspace nodes or workspace-edge metadata on the
//       honest corpus, so there is nothing to rekey. bun-text does synthesize
//       an extra empty root workspace node (`@0.0.0`) on parse, but Tier 3's
//       subset gate allows destination additions that do not erase source
//       state.
//     - No `multi-spec-collapsed` declaration on this real-fixture corpus:
//       none of the classic∩bun fixtures on disk carry a classic multi-spec
//       entry key, so advertising an INTEROP_* code here would violate
//       ADR-0020 §2 honesty.
//
//   bun-text -> yarn-classic (REVERSE, asymmetric):
//     - Honest corpus = 5 fixtures (deps-with-scopes, peers-basic, simple,
//       workspaces-basic, yarn-crlf). `peers-multi` is EXCLUDED: the bun-text
//       parser binds `@case-peers-multi/b` to the react@17 stack despite the
//       source-declared `18.2.0` ranges, while the classic round-trip
//       reconstructs the version-specific 18.x edges. Parse-side version-
//       selection blocker on the bun source, not an honest classic loss.
//     - `workspace-metadata` drops universally on the honest corpus. bun-text
//       always stamps the root node with `workspacePath: ''`, and workspace
//       fixtures additionally carry member `workspacePath` plus
//       `attrs.workspace` edge markers; yarn-classic reparses the same NodeIds
//       without that bookkeeping. The graph survives by id, but workspace
//       metadata does not.
//     - No `tarballs` loss on REVERSE: the shared bun-text source fixtures do
//       not carry inner-block `bin` or other tarball extras that would depend
//       on bun-side sidecars, and yarn-classic reconstructs integrity-only
//       tarballs cleanly on the honest corpus.
function buildCrossFamilyClassicToBun(): ConversionContract {
  return {
    from: 'yarn-classic',
    to:   'bun-text',
    preserved: withoutFeatures('resolved-url'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'yarn-classic source tarballs carry canonical `{type: "tarball", url}` resolution payloads via `resolved:`; bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the honest Phase D-iii corpus.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: CROSS_FAMILY_CLASSIC_BUN_FIXTURES.filter(
      (fixture): fixture is Exclude<typeof CROSS_FAMILY_CLASSIC_BUN_FIXTURES[number], 'peers-multi' | 'workspaces-basic'> =>
        fixture !== 'peers-multi' && fixture !== 'workspaces-basic',
    ),
  }
}

function buildCrossFamilyBunToClassic(): ConversionContract {
  return {
    from: 'bun-text',
    to:   'yarn-classic',
    preserved: withoutFeatures('workspace-membership'),
    lost: [
      {
        feature:    'workspace-metadata',
        diagnostic: 'INTEROP_BUN_TEXT_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity:   'info',
        rationale:  'bun-text always stamps the root node with `workspacePath: \'\'`, and workspace fixtures additionally carry member `workspacePath` plus `attrs.workspace` edge markers; yarn-classic reparses the same NodeIds without `workspacePath` / `attrs.workspace` bookkeeping. The graph survives by id, but workspace metadata does not.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: CROSS_FAMILY_CLASSIC_BUN_FIXTURES.filter(
      (fixture): fixture is Exclude<typeof CROSS_FAMILY_CLASSIC_BUN_FIXTURES[number], 'peers-multi'> =>
        fixture !== 'peers-multi',
    ),
  }
}

const CROSS_FAMILY_CLASSIC_BUN_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyClassicToBun(),
  buildCrossFamilyBunToClassic(),
]

// === cross-family yarn-berry-v9 <-> bun-text (ADR-0020 Phase C-v) ===========
//
// Empirically-probed loss profile across CROSS_FAMILY_YB9_BUN_FIXTURES (the
// 7-fixture intersection of yarn-berry-v9 and bun-text on-disk corpora;
// `patch-yarn` excluded — bun-text has no patch primitive per ADR-0014 §4.F2,
// dropped at the adapter layer via RECIPE_FEATURE_DROPPED; `git-github-tarball`
// excluded — no yarn-berry-v9.lock on disk):
//
//   yarn-berry-v9 -> bun-text (FORWARD, asymmetric):
//     - `workspace-rekey` UNIVERSAL across the 7-fixture corpus. yarn-berry
//       stamps the workspace root as `<pkg-name>@0.0.0-use.local` (yarn's
//       use.local sentinel); bun-text reconstructs the root via the
//       `workspaces[""]` manifest которое carries `version: undefined` for
//       root, so the bun-text parser falls back на the default `0.0.0`
//       version (per `parse()` at line 191 of `bun-text.ts`). Same workspace
//       graph, two NodeId shapes → root workspace node not preserved by id
//       in destination, outgoing edges from root appear orphaned to the
//       comparator. Subsumes graph-shape drops `nodes` / `edges` /
//       `edge-kinds` / `workspace-membership`. NB: distinct from yb9 ->
//       pnpm-v9 workspace-rekey case which also rekeys member ids — here
//       members survive по id because bun-text preserves the member-side
//       `version: '0.0.0-use.local'` через the `workspaces` map and emits
//       the member-ref `[<name>@workspace:<path>]` form (parser stamps
//       `${name}@${memberVersion}` per line 247). Only root rekeys.
//     - `resolved-url` UNIVERSAL across 6/7 fixtures (всё except patch-yarn
//       которое is excluded — see corpus rationale): yarn-berry source
//       carries canonical tarball resolution `{type: 'tarball', url: '...'}`
//       on every non-workspace node. bun-text's `packages` tuple emits only
//       the integrity slot, NOT the URL (ADR-0014 §4.F3 stringify table —
//       "positional slot — URL not emitted; integrity slot only"). Per-node
//       `tarball.resolution.type` degrades `tarball -> undefined` on every
//       tarball-bearing node (the resolved-url arm skips nodes с
//       `srcCanonical.type === 'unknown'` so the workspace-cross-refs
//       fixture's `link:` resolution doesn't trip it either; only the pure
//       tarball-typed sources fire).
//     - `tarballs` drops on 2/7 fixtures (peers-basic, peers-multi):
//       `loose-envify@1.4.0` carries `tarball.bin = {"loose-envify": "cli.js"}`
//       on the yarn-berry-v9 source. bun-text stringify emits inner-block
//       `bin` only if the parse-time sidecar carried one (line 992 of
//       `bun-text.ts`); cross-family sources lack the bun-text sidecar so
//       `bin` drops on emit. simple / deps-with-scopes / workspace-cross-refs
//       / workspaces-basic / yarn-crlf carry no tarball extras so the loss
//       does not fire.
//     - `RECIPE_WORKSPACE_COLLAPSED` (info) fires on workspace-cross-refs
//       (F4 collapse — yb9 source carries richer specifier shapes, bun-text
//       member-ref form has no version range so collapses to `workspace:*`).
//       Already declared at the adapter layer per ADR-0014 §5; NOT lifted к
//       INTEROP_* per the existing precedent (workspace-collapse is a recipe
//       primitive event, not a graph-state loss).
//     - Reentrancy `asymmetric` (precedent-aligned с all other cross-family
//       contracts; graph identity round-trip blocked by workspace-rekey).
//
//   bun-text -> yarn-berry-v9 (REVERSE, asymmetric):
//     - Graph state fully preserved across all 7 fixtures: workspace identity
//       aligns (bun-text source uses package-name + manifest-version shape,
//       yarn-berry-v9 parser round-trips by id), no peer-virt to begin with
//       (bun encodes peers declaratively), no resolution-type degradation
//       (yarn-berry-v9 reconstructs the registry URL from convention on
//       reparse).
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally: yarn-
//       berry destinations always synthesise a `__metadata` block (version +
//       cacheKey) absent from bun-text sources. Mirrors classic->berry,
//       pnpm-v9->yb9 (Phase C-ii), и npm-3->yb9 (Phase C-iii) precedent.
//     - `tarballs` does NOT drop on REVERSE: bun-text sources don't carry
//       sidecar-gated tarball extras (parser stashes only `bin` into the
//       inner-block sidecar; the inner-block sidecar lives на the bun-text
//       per-graph sidecar, not consumed by yarn-berry-v9 stringify, но since
//       NO bun-text source fixture carries inner.bin the sidecar-bridge gap
//       doesn't fire). simple / workspaces-basic / workspace-cross-refs etc
//       all empty-inner. Distinct from yb9 -> pnpm-v9 (Phase C-i) и npm-3
//       -> yb9 (Phase C-iii) reverse directions which fire tarballs loss.
//     - Reentrancy `asymmetric`: A(bun)->B(yb9)->A(bun) reproduces A's graph
//       byte-equal on the full 7-fixture corpus, но the synthesized
//       `__metadata.version` addition still disqualifies lockfile-text
//       round-trip honesty. Asymmetric matches the existing Phase C-*
//       precedent.
function buildCrossFamilyYb9ToBun(): ConversionContract {
  return {
    from: 'yarn-berry-v9',
    to:   'bun-text',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership', 'resolved-url', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_BUN_TEXT_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'yarn-berry stamps the workspace root as `<name>@0.0.0-use.local` (yarn-internal use.local sentinel); bun-text reconstructs the root from the `workspaces[""]` manifest which carries no `version` field, so the bun-text parser falls back to default `0.0.0` (per `bun-text.ts:191`). Same workspace graph, two NodeId conventions for the root node → root not preserved by id in destination, outgoing edges from root appear orphaned to the comparator. Subsumes graph-shape drops `nodes` / `edges` / `edge-kinds` / `workspace-membership`. NB: workspace MEMBERS survive by id (bun-text emits members via the member-ref `[<name>@workspace:<path>]` shape which preserves the yarn-side `0.0.0-use.local` version through the `workspaces` map), so this is a ROOT-only rekey distinct from yb9 -> pnpm-v9 (Phase C-i) which also rekeys members.',
      },
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` (4-slot form per ADR-0014 §4.F3 stringify table — "positional slot — URL not emitted; integrity slot only"). Source-side canonical `tarball.resolution = {type: "tarball", url: "..."}` degrades to `undefined` on every non-workspace tarball-bearing node in the destination, since bun-text has no slot to round-trip the URL. Fires on every fixture in the corpus (simple, deps-with-scopes, peers-basic, peers-multi, workspaces-basic, yarn-crlf, workspace-cross-refs) — distinct from yb9 -> npm-3 (Phase C-iii) where the loss stands alone (npm-3 emits the PM-native locator into `resolved:` but the npm-3 parser cannot translate it back to tarball type); here the loss stands alone because bun-text emits NO URL at all.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_BUN_TEXT_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras (`bin`, и by extension `cpu` / `os` / `engines` if a fixture carried them) drop across the cross-family boundary — yarn-berry-v9 holds them in `_yarn-berry-core.ts` per-graph sidecars distinct from bun-text per-graph sidecars in `bun-text.ts`. bun-text stringify emits inner-block `bin` only via the parse-time sidecar lookup (`sidecar?.nodes.get(node.id)?.inner?.bin`, line 992 of `bun-text.ts`); cross-family sources lack the bun-text sidecar so `bin` drops on emit. Mirrors the Phase B pnpm-v5 <-> {v6,v9} and Phase C-i yb9 <-> pnpm-v9 sidecar-bridge gap pattern. Fires on `peers-basic` / `peers-multi` (`loose-envify@1.4.0` bin field); simple / deps-with-scopes / workspace-cross-refs / workspaces-basic / yarn-crlf carry no tarball extras so the loss does not fire.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_BUN_FIXTURES],
  }
}

function buildCrossFamilyBunToYb9(): ConversionContract {
  return {
    from: 'bun-text',
    to:   'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_BUN_TEXT_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry destinations always synthesise a `__metadata` preamble (version + cacheKey) absent from bun-text sources; mirrors the classic->berry, pnpm-v9->yb9 (Phase C-ii), и npm-3->yb9 (Phase C-iii) precedent.',
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_YB9_BUN_FIXTURES],
  }
}

const CROSS_FAMILY_YB9_BUN_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyYb9ToBun(),
  buildCrossFamilyBunToYb9(),
]

// === cross-family yarn-berry-v{4,5,6,8} <-> bun-text (ADR-0020 Phase E-iii) =
//
// Older-berry expansion of the modern yb9 <-> bun-text pair. Probe matched the
// existing directional shape exactly, with only corpus width and preamble
// version literal differing:
//
//   yarn-berry-v4 -> bun-text (FORWARD, asymmetric):
//     - Corpus = CROSS_FAMILY_YB4_BUN_FIXTURES (6 fixtures). `git-github-
//       tarball` / `patch-yarn` / `workspace-cross-refs` are absent from the
//       disk intersection.
//     - `workspace-rekey` is universal and ROOT-only exactly as in the yb9
//       pair: berry stamps the root as `<name>@0.0.0-use.local`, while bun-text
//       reparses the root from `workspaces[""]` with fallback `0.0.0`. Member
//       ids survive where present, but the root id does not.
//     - `resolved-url` is universal on every tarball-bearing node: bun-text's
//       tuple form emits integrity only, never the canonical tarball URL.
//     - `tarballs` drops on peers-basic / peers-multi only: same sidecar bridge
//       gap as yb9 forward (`loose-envify` bin payload).
//
//   yarn-berry-v{5,6,8} -> bun-text (FORWARD, asymmetric):
//     - Corpus = CROSS_FAMILY_YB_MID_BUN_FIXTURES (7 fixtures): same as the yb9
//       pair minus `patch-yarn`, with `workspace-cross-refs` included.
//     - Loss shape matches yb9 forward exactly: root-only `workspace-rekey`
//       universal, `resolved-url` universal, `tarballs` on peers-basic /
//       peers-multi only. No conditions-specific loss surfaced because no shared
//       fixture carries a conditions block on disk.
//
//   bun-text -> yarn-berry-v{4,5,6,8} (REVERSE, asymmetric):
//     - Graph state is preserved across the honest corpora exactly as in the
//       yb9 reverse pair. No peer-virt, no workspace rekey, no tarball-sidecar
//       loss on current bun-text fixtures.
//     - `__metadata.version` PREAMBLE_SYNTHESIZED fires universally, with the
//       destination literal `4`, `5`, `6`, or `8`.
// `OlderBerryFormat` enumerates the pre-v9 berry generations that participate
// in cross-family contracts. v7 is intentionally excluded: it is a Yarn 4 RC
// transitional `__metadata.version: 7` shape that has no on-disk shared
// fixture corpus reachable via `_gen.mjs` and no real-world cross-family
// probe demand outside intra-family + real-world v7 sources. Cross-family
// v7 contracts can be added under a follow-up dispatch if a v7-bearing
// corpus lands.
type OlderBerryFormat = Exclude<BerryFormat, 'yarn-berry-v7' | 'yarn-berry-v9' | 'yarn-berry-v10'>

const OLDER_BERRY_BUN_FORMATS: OlderBerryFormat[] = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v8',
]

const OLDER_BERRY_BUN_FIXTURES: Record<OlderBerryFormat, readonly string[]> = {
  'yarn-berry-v4': CROSS_FAMILY_YB4_BUN_FIXTURES,
  'yarn-berry-v5': CROSS_FAMILY_YB_MID_BUN_FIXTURES,
  'yarn-berry-v6': CROSS_FAMILY_YB_MID_BUN_FIXTURES,
  'yarn-berry-v8': CROSS_FAMILY_YB_MID_BUN_FIXTURES,
}

function buildCrossFamilyYbOlderToBun(from: OlderBerryFormat): ConversionContract {
  const version = BERRY_VERSION[from]
  return {
    from,
    to:   'bun-text',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership', 'resolved-url', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_WORKSPACE_REKEY`,
        severity:   'warning',
        rationale:  `yarn-berry-v${version} stamps the workspace root as \`<name>@0.0.0-use.local\`; bun-text reconstructs the root from the \`workspaces[""]\` manifest which carries no \`version\` field, so the bun-text parser falls back to default \`0.0.0\`. Same workspace graph, two NodeId conventions for the root node -> root not preserved by id in destination, outgoing edges from root appear orphaned to the comparator. Subsumes graph-shape drops \`nodes\` / \`edges\` / \`edge-kinds\` / \`workspace-membership\`. Workspace members survive by id where present, so this matches the ROOT-only rekey already observed on yb9 -> bun-text.`,
      },
      {
        feature:    'resolved-url',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_RESOLVED_URL_DROPPED`,
        severity:   'warning',
        rationale:  'bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Source-side canonical `tarball.resolution = {type: "tarball", url: "..."}` therefore degrades to `undefined` on every non-workspace tarball-bearing node in the destination.',
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras drop across the cross-family boundary — yarn-berry-v${version} holds them in \`_yarn-berry-core.ts\` per-graph sidecars distinct from bun-text per-graph sidecars in \`bun-text.ts\`. bun-text stringify emits inner-block \`bin\` only via its parse-time sidecar lookup, so cross-family sources drop the \`loose-envify@1.4.0\` CLI \`bin\` payload on \`peers-basic\` / \`peers-multi\`.`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_BERRY_BUN_FIXTURES[from]],
  }
}

function buildCrossFamilyBunToYbOlder(to: OlderBerryFormat): ConversionContract {
  const version = BERRY_VERSION[to]
  return {
    from: 'bun-text',
    to,
    preserved: ALL_FEATURES,
    lost: [],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: `INTEROP_BUN_TEXT_TO_${fromCode(to)}_PREAMBLE_SYNTHESIZED`,
        severity:   'info',
        rationale:  `yarn-berry-v${version} destinations always synthesise a \`__metadata\` preamble (version literal \`${version}\`, optional cacheKey) absent from bun-text sources; mirrors the classic->berry, pnpm-v9->yb*, npm-3->yb*, and bun-text->yb9 precedents.`,
      },
    ],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_BERRY_BUN_FIXTURES[to]],
  }
}

const CROSS_FAMILY_YB_OLDER_BUN_CONTRACTS: ConversionContract[] = OLDER_BERRY_BUN_FORMATS.flatMap(
  format => [
    buildCrossFamilyYbOlderToBun(format),
    buildCrossFamilyBunToYbOlder(format),
  ],
)

// === cross-family pnpm-v9 <-> bun-text (ADR-0020 Phase C-vi) ================
//
// Empirically-probed loss profile across CROSS_FAMILY_PNPM9_BUN_FIXTURES (the
// 7-fixture intersection of pnpm-v9 and bun-text on-disk corpora; `patch-yarn`
// excluded from the shared corpus because only the pnpm-v9 side exists on disk
// and bun-text drops patches at the adapter layer via RECIPE_FEATURE_DROPPED):
//
//   pnpm-v9 -> bun-text (FORWARD, asymmetric):
//     - `resolved-url` UNIVERSAL across the 7-fixture corpus. pnpm-v9 source
//       tarballs carry canonical `{type: 'tarball', url}` payloads; bun-text
//       emits regular packages as positional tuples `[<id>, "", <inner>,
//       "<integrity>"]` and has no URL slot, so the canonical resolution
//       degrades to `undefined` on every non-workspace tarball-bearing node.
//     - `tarballs` fires on 5/7 fixtures (deps-with-scopes, peers-basic,
//       peers-multi, workspace-cross-refs, yarn-crlf). The cross-family
//       boundary loses sidecar-gated tarball extras because pnpm-v9 keeps
//       them in `_pnpm-flat-core.ts`'s WeakMap while bun-text stringify reads
//       only the bun-side sidecar. Probe confirms `engines` drops on
//       deps-with-scopes / yarn-crlf, and `bin: "true"` drops on
//       loose-envify in the peer fixtures.
//     - `peer-virt` fires on peers-basic / peers-multi only. bun-text has no
//       peer-context NodeId primitive; `react-dom@18.2.0(react@18.2.0)` (and
//       the multi-stack analogue) flattens to bare `react-dom@...`, which in
//       turn makes `nodes` / `edges` / `edge-kinds` / `integrity` fail the
//       subset comparator on those fixtures. `BUN_TEXT_PEER_VIRT_FLATTENED`
//       remains the adapter-layer diagnostic; the contract lifts the graph
//       state loss honestly as `peer-virt`.
//     - `RECIPE_WORKSPACE_COLLAPSED` (info) fires on workspace-cross-refs:
//       pnpm-v9 source ranges `workspace:^` / `workspace:1.0.0` collapse to
//       bun-text's single member-ref form, reparsing as `workspace:*`. This
//       remains adapter-layer only per existing ADR-0014/ADR-0020 precedent.
//
//   bun-text -> pnpm-v9 (REVERSE, asymmetric):
//     - `workspace-rekey` UNIVERSAL across the 7-fixture corpus. bun-text
//       parses the root as `<manifest-name>@<manifest-version>` and workspace
//       members as `<pkg-name>@<member-version>`; pnpm-v9 stringifies and
//       reparses them as path-keyed locators (`.@<version>` for root,
//       `<workspacePath>@<version>` for members). Same workspace graph, two
//       NodeId conventions → root-only fixtures lose the root id, workspace
//       fixtures additionally rekey every member. Subsumes `nodes` / `edges` /
//       `edge-kinds` / `workspace-membership`.
//     - No `resolved-url` or `tarballs` loss on REVERSE: bun-text source
//       tarballs carry integrity only, and pnpm-v9 reconstructs canonical
//       tarball URLs by convention on stringify+parse. Since tarball
//       comparison ignores resolution attribution, the source tarball payloads
//       are preserved.
function buildCrossFamilyPnpm9ToBun(): ConversionContract {
  return {
    from: 'pnpm-v9',
    to:   'bun-text',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_BUN_TEXT_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'bun-text has no peer-context NodeId primitive. pnpm-v9 source nodes such as `react-dom@18.2.0(react@18.2.0)` flatten to bare `react-dom@18.2.0` on stringify+parse (`BUN_TEXT_PEER_VIRT_FLATTENED` at the adapter layer), so the peer-virtualized node id and its outgoing edges are no longer reachable by id in destination. Fires on peers-basic / peers-multi and subsumes the associated `nodes` / `edges` / `edge-kinds` / `integrity` graph-subset failures on those fixtures.',
      },
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_PNPM_V9_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'pnpm-v9 source tarballs carry canonical `{type: "tarball", url}` resolution payloads; bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the shared corpus.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_PNPM_V9_TO_BUN_TEXT_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'sidecar-gated TarballPayload extras drop across the cross-family boundary. pnpm-v9 stores them in `_pnpm-flat-core.ts` graph sidecars, while bun-text stringify emits inner-block extras only from bun-text parse-time sidecars. Probe confirms `engines` drops on deps-with-scopes / yarn-crlf (`@sindresorhus/is`, `is-buffer`) and `bin: "true"` drops on loose-envify in peers-basic / peers-multi; workspace-cross-refs also loses `is-buffer` engines metadata through the same bridge gap.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_PNPM9_BUN_FIXTURES],
  }
}

function buildCrossFamilyBunToPnpm9(): ConversionContract {
  return {
    from: 'bun-text',
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_BUN_TEXT_TO_PNPM_V9_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'bun-text parses the root as `<manifest-name>@<manifest-version>` and workspace members as `<pkg-name>@<member-version>`, while pnpm-v9 reparses them as path-keyed locators (`.@<version>` for root, `<workspacePath>@<version>` for members). Even non-workspace fixtures lose the root id (`case-simple@0.0.0` -> `.@0.0.0`); workspace fixtures additionally rekey every member (`@case-ws/a@0.0.0` -> `packages/a@0.0.0`, etc.). The workspace graph survives, but by different NodeIds, so `nodes` / `edges` / `edge-kinds` / `workspace-membership` are not preserved by the id-based comparator.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_PNPM9_BUN_FIXTURES],
  }
}

const CROSS_FAMILY_PNPM9_BUN_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyPnpm9ToBun(),
  buildCrossFamilyBunToPnpm9(),
]

// === cross-family pnpm-v{5,6} <-> bun-text (ADR-0020 Phase E-iv) ===========
//
// Probe target extends the pnpm-v9 <-> bun-text pair to the older pnpm
// generations on the same 7-fixture shared-disk corpus. Version deltas are the
// same as elsewhere in Phase E-iv: pnpm-v5 uses its standalone sidecar and has
// no patch primitive; pnpm-v6 matches the flat-core modern loss shape.
const OLDER_PNPM_BUN_FIXTURES: Record<OlderPnpmFormat, readonly string[]> = {
  'pnpm-v5': CROSS_FAMILY_PNPM5_BUN_FIXTURES,
  'pnpm-v6': CROSS_FAMILY_PNPM6_BUN_FIXTURES,
}

function buildCrossFamilyOlderPnpmToBun(from: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[from]
  const sourceSidecar = from === 'pnpm-v5'
    ? 'the pnpm-v5 private graph sidecar in `pnpm-v5.ts`'
    : 'the `_pnpm-flat-core.ts` WeakMap used by pnpm-v6'
  return {
    from,
    to:   'bun-text',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_PEER_VIRT_DROPPED`,
        severity:   'warning',
        rationale:  `bun-text has no peer-context NodeId primitive. pnpm-v${version} source nodes such as \`react-dom@18.2.0(react@18.2.0)\` flatten to bare \`react-dom@18.2.0\` on stringify+parse, so the peer-virtualized node id and its outgoing edges are no longer reachable by id in destination. Fires on peers-basic / peers-multi and subsumes the associated \`nodes\` / \`edges\` / \`edge-kinds\` / \`integrity\` graph-subset failures on those fixtures.`,
      },
      {
        feature:    'resolved-url',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_RESOLVED_URL_DROPPED`,
        severity:   'warning',
        rationale:  `pnpm-v${version} source tarballs carry canonical \`{type: "tarball", url}\` resolution payloads; bun-text emits regular packages as positional tuples \`[<id>, "", <inner>, "<integrity>"]\` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the shared corpus.`,
      },
      {
        feature:    'tarballs',
        diagnostic: `INTEROP_${fromCode(from)}_TO_BUN_TEXT_TARBALLS_DROPPED`,
        severity:   'warning',
        rationale:  `sidecar-gated TarballPayload extras drop across the cross-family boundary. pnpm-v${version} stores them in ${sourceSidecar}, while bun-text stringify emits inner-block extras only from bun-text parse-time sidecars. Probe target covers \`engines\` drops on deps-with-scopes / workspace-cross-refs / yarn-crlf and \`bin\` loss on loose-envify in peers-basic / peers-multi.`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_PNPM_BUN_FIXTURES[from]],
  }
}

function buildCrossFamilyBunToOlderPnpm(to: OlderPnpmFormat): ConversionContract {
  const version = OLDER_PNPM_VERSION[to]
  return {
    from: 'bun-text',
    to,
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: `INTEROP_BUN_TEXT_TO_${fromCode(to)}_WORKSPACE_REKEY`,
        severity:   'warning',
        rationale:  `bun-text parses the root as \`<manifest-name>@<manifest-version>\` and workspace members as \`<pkg-name>@<member-version>\`, while pnpm-v${version} reparses them as path-keyed locators (\`.@<version>\` for root, \`<workspacePath>@<version>\` for members). Even non-workspace fixtures lose the root id; workspace fixtures additionally rekey every member. The workspace graph survives, but by different NodeIds, so \`nodes\` / \`edges\` / \`edge-kinds\` / \`workspace-membership\` are not preserved by the id-based comparator.`,
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: [...OLDER_PNPM_BUN_FIXTURES[to]],
  }
}

const CROSS_FAMILY_OLDER_PNPM_BUN_CONTRACTS: ConversionContract[] = OLDER_PNPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderPnpmToBun(format),
    buildCrossFamilyBunToOlderPnpm(format),
  ],
)

// === cross-family npm-3 <-> bun-text (ADR-0020 Phase C-vii) =================
//
// Closes the 4-major-family modern-version ring. Empirically-probed loss
// profile across CROSS_FAMILY_NPM3_BUN_FIXTURES (the 6-fixture on-disk
// intersection of npm-3 and bun-text):
//
//   npm-3 -> bun-text (FORWARD, asymmetric):
//     - `resolved-url` fires on the honest 5-fixture corpus (`peers-multi`
//       excluded; see blocker note below). npm-3 source tarballs carry
//       canonical `{type: 'tarball', url}` resolution payloads via the
//       `resolved:` field; bun-text emits regular packages as positional tuples
//       `[<id>, "", <inner>, "<integrity>"]` with no URL slot, so the
//       canonical resolution degrades to `undefined` on every non-workspace
//       tarball-bearing node.
//     - `tarballs` fires on 3/5 fixtures (deps-with-scopes, peers-basic,
//       yarn-crlf; peers-multi would also fire but is excluded for an
//       unrelated blocker). npm-3 parses tarball extras (`engines`, `funding`,
//       `bin`, etc.) onto the canonical TarballPayload via `_npm-core.ts`;
//       bun-text reparses regular packages as integrity-only tarballs
//       (`bun-text.ts` sets only slot-4 integrity on the graph). Probe confirms
//       the bridge gap on `@sindresorhus/is` / `is-buffer` metadata and
//       `loose-envify`'s `bin` field.
//     - No `workspace-rekey`: unlike pnpm-v9 <-> bun-text, both adapters stamp
//       root and workspace-member ids by package-name + manifest-version. The
//       Phase C-vii probe showed all workspace ids preserved by exact NodeId on
//       `workspaces-basic`.
//
//   `peers-multi` excluded from FORWARD corpus: bun-text reparses the
//     `@case-peers-multi/b` workspace edges onto the react@17 stack instead of
//     the source-declared react@18 stack and rewires `react-dom@18.2.0` from
//     `scheduler@0.23.2` to `scheduler@0.20.2`. This is a consumer-scoped
//     edge-resolution / de-hoist reconstruction blocker in bun-text when fed an
//     npm-flat-shaped source graph, NOT a declared `resolved-url` / `tarballs`
//     loss. Per ADR-0020 honesty principle: narrow the corpus, track the
//     blocker separately.
//
//   bun-text -> npm-3 (REVERSE, asymmetric):
//     - Graph state fully preserved across the honest 6-fixture corpus: no
//       workspace rekey, no peer-virt to begin with, no tarball extras on the
//       bun-text source side that npm-3 would fail to store, and npm-3
//       reconstructs canonical tarball URLs from bun's integrity-only tuples.
//       Probe observed zero loss diagnostics on deps-with-scopes, peers-basic,
//       peers-multi, simple, workspaces-basic, and yarn-crlf.
function buildCrossFamilyNpm3ToBun(): ConversionContract {
  return {
    from: 'npm-3',
    to:   'bun-text',
    preserved: withoutFeatures('resolved-url', 'tarballs'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_NPM_3_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'npm-3 source tarballs carry canonical `{type: "tarball", url}` resolution payloads via `resolved:`; bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the honest Phase C-vii corpus.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_3_TO_BUN_TEXT_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'npm-3 parses tarball extras (`engines`, `funding`, `bin`, etc.) onto the canonical TarballPayload via `_npm-core.ts`, but bun-text reparses regular packages as integrity-only tarballs (`bun-text.ts` sets only slot-4 integrity on the graph). The cross-family bridge therefore drops tarball metadata on deps-with-scopes (`@sindresorhus/is`), peers-basic (`loose-envify` bin / react engines), and yarn-crlf (`is-buffer` metadata). simple / workspaces-basic carry no tarball extras so the loss does not fire there.',
      },
    ],
    added:        [],
    passthrough:  [],
    reentrancy:   'asymmetric',
    fixtureSubset: CROSS_FAMILY_NPM3_BUN_FIXTURES.filter(
      (fixture): fixture is Exclude<typeof CROSS_FAMILY_NPM3_BUN_FIXTURES[number], 'peers-multi'> =>
        fixture !== 'peers-multi',
    ),
  }
}

function buildCrossFamilyBunToNpm3(): ConversionContract {
  return {
    from: 'bun-text',
    to:   'npm-3',
    preserved: ALL_FEATURES,
    lost:        [],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_NPM3_BUN_FIXTURES],
  }
}

const CROSS_FAMILY_NPM3_BUN_CONTRACTS: ConversionContract[] = [
  buildCrossFamilyNpm3ToBun(),
  buildCrossFamilyBunToNpm3(),
]

// === cross-family npm-{1,2} <-> yarn-berry-v9 (ADR-0020 Phase E-v) =========
//
// Older-npm expansion of the modern yb9 <-> npm-3 pair:
//
//   npm-2 <-> yb9: probe matched the npm-3 pair exactly on the same 6-fixture
//     disk intersection.
//
//   npm-1 <-> yb9: honest corpus narrows to CROSS_FAMILY_NPM1_YB9_FIXTURES.
//     The npm-1 fixtures on `peers-multi` / `workspaces-basic` do not preserve
//     the workspace-member graph on disk, so they stay out per ADR-0021
//     §A.npm-1. On the narrowed 5-fixture corpus:
//       - npm-1 -> yb9 preserves graph state; yb9 only synthesizes
//         `__metadata.version`.
//       - yb9 -> npm-1 drops `resolved-url` on the registry-tarball fixtures,
//         loses `edges` on deps-with-scopes / peers-basic through the npm-1
//         hoist plan, loses `tarballs` on peers-basic / patch-yarn, and drops
//         the patch slot on patch-yarn.
const OLDER_NPM_TO_YB9_FIXTURES: Record<OlderNpmFormat, readonly string[]> = {
  'npm-1': CROSS_FAMILY_NPM1_YB9_FIXTURES,
  'npm-2': CROSS_FAMILY_YB9_NPM3_FIXTURES,
}

function buildCrossFamilyOlderNpmToYb9(from: OlderNpmFormat): ConversionContract {
  if (from === 'npm-1') {
    return {
      from,
      to:   'yarn-berry-v9',
      preserved: ALL_FEATURES,
      lost: [],
      added: [
        {
          field:      '__metadata.version',
          source:     'static',
          diagnostic: 'INTEROP_NPM_1_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
          severity:   'info',
          rationale:  'yarn-berry-v9 destinations always synthesize a `__metadata` preamble (version literal `9`, cacheKey `10c0`) absent from npm-1 sources; the narrowed npm-1 corpus otherwise round-trips graph state cleanly.',
        },
      ],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...OLDER_NPM_TO_YB9_FIXTURES[from]],
    }
  }

  return {
    from,
    to:   'yarn-berry-v9',
    preserved: withoutFeatures('tarballs'),
    lost: [
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_2_TO_YARN_BERRY_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'TarballPayload extras (`engines`, `funding`) drop across the cross-family boundary — npm-2 holds them in the shared npm sidecar (`_npm-core.ts`) distinct from yarn-berry-v9 per-graph sidecars (`_yarn-berry-core.ts`). Fires on deps-with-scopes (`@sindresorhus/is@6.3.1`: engines + funding), peers-basic / peers-multi (`react@18.2.0`, `object-assign@4.1.1`, `react@17.0.2`: engines; `loose-envify@1.4.0`: bin shape), and yarn-crlf (`is-buffer@2.0.5`: engines + funding). Mirrors the npm-3 -> yb9 reverse pair.',
      },
    ],
    added: [
      {
        field:      '__metadata.version',
        source:     'static',
        diagnostic: 'INTEROP_NPM_2_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
        severity:   'info',
        rationale:  'yarn-berry-v9 destinations always synthesize a `__metadata` preamble (version literal `9`, cacheKey `10c0`) absent from npm-2 sources; mirrors the npm-3 -> yb9 precedent.',
      },
    ],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...OLDER_NPM_TO_YB9_FIXTURES[from]],
  }
}

function buildCrossFamilyYb9ToOlderNpm(to: OlderNpmFormat): ConversionContract {
  if (to === 'npm-1') {
    return {
      from: 'yarn-berry-v9',
      to,
      preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'patch-slots'),
      lost: [
        {
          feature:    'edges',
          diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_1_EDGES_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 nested-tree emit runs without a native hoist sidecar, so some requires targets are no longer visible from the consumer path on reparse (`NPM_UNRESOLVED_DEP`). Fires on deps-with-scopes (`@types/node -> undici-types`) and peers-basic (react / react-dom transitive requires).',
        },
        {
          feature:    'resolved-url',
          diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_1_RESOLVED_URL_DROPPED',
          severity:   'warning',
          rationale:  'yarn-berry-v9 emits PM-native locators into npm-1 `resolved:` fields. npm-1 reparses those as unknown/raw attribution instead of canonical registry URLs, so canonical tarball resolution degrades on the non-patch registry fixtures.',
        },
        {
          feature:    'tarballs',
          diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_1_TARBALLS_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 entry schema cannot preserve PM-native tarball extras. Probe confirmed `bin` loss on peers-basic (`loose-envify@1.4.0`) and patched-node tarball collapse once patch-yarn drops the patch slot.',
        },
        {
          feature:    'patch',
          diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_1_PATCH_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 has no patch primitive. The patch-bearing `lodash@4.17.21+patch=…` node in patch-yarn loses its `Node.patch` attribute on emit and reparses as bare `lodash@4.17.21`, matching the adapter-layer `RECIPE_FEATURE_DROPPED` path.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...OLDER_NPM_TO_YB9_FIXTURES[to]],
    }
  }

  return {
    from: 'yarn-berry-v9',
    to,
    preserved: withoutFeatures('resolved-url'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_NPM_2_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'yarn-berry-v9 stringifier emits the PM-native locator `<name>@npm:<version>` into the npm-2 `resolved:` field; the npm-2 parser cannot translate that back to a registry tarball URL, so canonical `tarball.resolution.type` degrades `tarball -> unknown`. Mirrors the yb9 -> npm-3 pair.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...OLDER_NPM_TO_YB9_FIXTURES[to]],
  }
}

const CROSS_FAMILY_YB9_OLDER_NPM_CONTRACTS: ConversionContract[] = OLDER_NPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderNpmToYb9(format),
    buildCrossFamilyYb9ToOlderNpm(format),
  ],
)

// === cross-family npm-{1,2} <-> pnpm-v9 (ADR-0020 Phase E-v) ===============
//
// Older-npm expansion of the pnpm-v9 <-> npm-3 pair:
//
//   npm-2 <-> pnpm-v9: probe matched the npm-3 pair exactly on the same
//     6-fixture disk intersection.
//
//   npm-1 <-> pnpm-v9: honest corpus narrows to CROSS_FAMILY_NPM1_PNPM9_FIXTURES
//     (same npm-1 workspace/topology exclusion as above, with patch-yarn kept).
//     On the narrowed 5-fixture corpus:
//       - npm-1 -> pnpm-v9 rekeys the root workspace node universally
//         (`case-*@0.0.0` -> `.@0.0.0`), subsuming the graph-shape drops.
//       - pnpm-v9 -> npm-1 loses the same npm-1 downgrade features as Phase A,
//         plus peer-virt on peers-basic and patch on patch-yarn.
const OLDER_NPM_TO_PNPM9_FIXTURES: Record<OlderNpmFormat, readonly string[]> = {
  'npm-1': CROSS_FAMILY_NPM1_PNPM9_FIXTURES,
  'npm-2': CROSS_FAMILY_PNPM9_NPM3_FIXTURES,
}

function buildCrossFamilyOlderNpmToPnpm9(from: OlderNpmFormat): ConversionContract {
  if (from === 'npm-1') {
    return {
      from,
      to:   'pnpm-v9',
      preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership'),
      lost: [
        {
          feature:    'workspace-rekey',
          diagnostic: 'INTEROP_NPM_1_TO_PNPM_V9_WORKSPACE_REKEY',
          severity:   'warning',
          rationale:  'npm-1 stamps the root workspace node by package name (`<pkg-name>@<version>`), while pnpm-v9 reparses it as the path-keyed importer id `.@<version>`. On the current narrowed corpus this root-only rekey is universal and subsumes `nodes` / `edges` / `edge-kinds` / `workspace-membership`.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...OLDER_NPM_TO_PNPM9_FIXTURES[from]],
    }
  }

  return {
    from,
    to:   'pnpm-v9',
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'workspace-membership', 'tarballs'),
    lost: [
      {
        feature:    'workspace-rekey',
        diagnostic: 'INTEROP_NPM_2_TO_PNPM_V9_WORKSPACE_REKEY',
        severity:   'warning',
        rationale:  'npm-2 stamps workspace identity by package name (root = `<pkg-name>@<version>`, members = `<pkg-name>@<version>`), while pnpm-v9 stamps by path (root = `.@<version>`, members = `<workspacePath>@<version>`). Same workspace graph, two NodeId conventions -> source workspace nodes are not preserved by id in destination, subsuming `nodes` / `edges` / `edge-kinds` / `workspace-membership`. Mirrors the npm-3 -> pnpm-v9 pair.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_2_TO_PNPM_V9_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'TarballPayload extras (`bin`, `funding`) drop across the cross-family boundary — npm-2 holds them in the per-graph npm sidecar (`_npm-core.ts`) distinct from pnpm-v9 flat-core WeakMap (`_pnpm-flat-core.ts`). Fires on `funding` (deps-with-scopes `@sindresorhus/is@6.3.1`, yarn-crlf `is-buffer@2.0.5`) and on `bin` (peers-basic / peers-multi `loose-envify@1.4.0`). Mirrors the npm-3 -> pnpm-v9 pair.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...OLDER_NPM_TO_PNPM9_FIXTURES[from]],
  }
}

function buildCrossFamilyPnpm9ToOlderNpm(to: OlderNpmFormat): ConversionContract {
  if (to === 'npm-1') {
    return {
      from: 'pnpm-v9',
      to,
      preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'patch-slots', 'peer-virt'),
      lost: [
        {
          feature:    'edges',
          diagnostic: 'INTEROP_PNPM_V9_TO_NPM_1_EDGES_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 nested-tree emit cannot preserve all flat per-consumer requires. Probe confirmed unresolved transitive edges on deps-with-scopes (`@types/node -> undici-types`) and peers-basic (loose-envify / react requires), matching the Phase A npm downgrade shape.',
        },
        {
          feature:    'peer-virt',
          diagnostic: 'INTEROP_PNPM_V9_TO_NPM_1_PEER_VIRT_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 has no peer-context NodeId primitive. Source ids such as `react-dom@18.2.0(react@18.2.0)` flatten to bare ids on emit, so the peer-virtualized node and its outgoing edges become unreachable by id in destination. Fires on peers-basic and subsumes the associated `nodes` / `integrity` / `resolved-url` failures there.',
        },
        {
          feature:    'patch',
          diagnostic: 'INTEROP_PNPM_V9_TO_NPM_1_PATCH_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 has no patch primitive. The patch-bearing `lodash@4.17.21` node in patch-yarn loses its `Node.patch` attribute on emit, matching the adapter-layer `RECIPE_FEATURE_DROPPED` path.',
        },
        {
          feature:    'tarballs',
          diagnostic: 'INTEROP_PNPM_V9_TO_NPM_1_TARBALLS_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 entry schema cannot preserve pnpm-v9 tarball extras. Probe confirmed `engines` loss on deps-with-scopes (`@sindresorhus/is@6.3.1`) and peers-basic (`react@18.2.0`), `bin` loss on peers-basic (`loose-envify@1.4.0`), yarn-crlf metadata loss on `is-buffer@2.0.5`, and patched-node tarball collapse on patch-yarn.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...OLDER_NPM_TO_PNPM9_FIXTURES[to]],
    }
  }

  return {
    from: 'pnpm-v9',
    to,
    preserved: withoutFeatures('nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'peer-virt'),
    lost: [
      {
        feature:    'peer-virt',
        diagnostic: 'INTEROP_PNPM_V9_TO_NPM_2_PEER_VIRT_DROPPED',
        severity:   'warning',
        rationale:  'npm-2 cannot preserve parenthesized peer-context ids. Source `react-dom@18.2.0(react@18.2.0)` flattens to bare `react-dom@18.2.0` in destination, subsuming the associated `nodes` / `edges` / `edge-kinds` / `integrity` / `resolved-url` graph-subset failures on peers-basic. Mirrors the pnpm-v9 -> npm-3 pair.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...OLDER_NPM_TO_PNPM9_FIXTURES[to]],
  }
}

const CROSS_FAMILY_PNPM9_OLDER_NPM_CONTRACTS: ConversionContract[] = OLDER_NPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderNpmToPnpm9(format),
    buildCrossFamilyPnpm9ToOlderNpm(format),
  ],
)

// === cross-family npm-{1,2} <-> bun-text (ADR-0020 Phase E-v) ==============
//
// Older-npm expansion of the modern npm-3 <-> bun-text pair:
//
//   npm-2 -> bun-text keeps the same `resolved-url` + `tarballs` loss shape as
//     npm-3 -> bun-text, and inherits the same `peers-multi` bun-side blocker.
//     Reverse `bun-text -> npm-2` preserves graph state across the honest
//     6-fixture corpus.
//
//   npm-1 <-> bun-text narrows to CROSS_FAMILY_NPM1_BUN_FIXTURES. On the
//     narrowed 4-fixture corpus:
//       - npm-1 -> bun-text drops only `resolved-url`.
//       - bun-text -> npm-1 drops `edges` on deps-with-scopes / peers-basic;
//         the simple / yarn-crlf fixtures round-trip graph-losslessly.
const NPM2_TO_BUN_FIXTURES = CROSS_FAMILY_NPM3_BUN_FIXTURES.filter(
  (fixture): fixture is Exclude<typeof CROSS_FAMILY_NPM3_BUN_FIXTURES[number], 'peers-multi'> =>
    fixture !== 'peers-multi',
)

function buildCrossFamilyOlderNpmToBun(from: OlderNpmFormat): ConversionContract {
  if (from === 'npm-1') {
    return {
      from,
      to:   'bun-text',
      preserved: withoutFeatures('resolved-url'),
      lost: [
        {
          feature:    'resolved-url',
          diagnostic: 'INTEROP_NPM_1_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 source tarballs carry canonical `{type: "tarball", url}` resolution payloads via `resolved:`; bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the narrowed npm-1 corpus.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...CROSS_FAMILY_NPM1_BUN_FIXTURES],
    }
  }

  return {
    from,
    to:   'bun-text',
    preserved: withoutFeatures('resolved-url', 'tarballs'),
    lost: [
      {
        feature:    'resolved-url',
        diagnostic: 'INTEROP_NPM_2_TO_BUN_TEXT_RESOLVED_URL_DROPPED',
        severity:   'warning',
        rationale:  'npm-2 source tarballs carry canonical `{type: "tarball", url}` resolution payloads via `resolved:`; bun-text emits regular packages as positional tuples `[<id>, "", <inner>, "<integrity>"]` and has no URL slot. Reparse therefore drops the canonical tarball resolution on every non-workspace tarball-bearing node in the honest corpus, mirroring npm-3 -> bun-text.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_2_TO_BUN_TEXT_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'npm-2 parses tarball extras (`engines`, `funding`, `bin`, etc.) onto canonical TarballPayload state, but bun-text reparses regular packages as integrity-only tarballs. The bridge therefore drops tarball metadata on deps-with-scopes (`@sindresorhus/is`), peers-basic (`loose-envify` bin / react engines), and yarn-crlf (`is-buffer` metadata), matching the npm-3 -> bun-text pair.',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...NPM2_TO_BUN_FIXTURES],
  }
}

function buildCrossFamilyBunToOlderNpm(to: OlderNpmFormat): ConversionContract {
  if (to === 'npm-1') {
    return {
      from: 'bun-text',
      to,
      preserved: withoutFeatures('edges', 'edge-kinds'),
      lost: [
        {
          feature:    'edges',
          diagnostic: 'INTEROP_BUN_TEXT_TO_NPM_1_EDGES_DROPPED',
          severity:   'warning',
          rationale:  'npm-1 nested-tree emit cannot preserve every flat per-consumer requires edge from bun-text sources. Probe confirmed edge drop on deps-with-scopes (`@types/node -> undici-types`) and peers-basic (loose-envify / react requires), while simple / yarn-crlf round-trip cleanly.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...CROSS_FAMILY_NPM1_BUN_FIXTURES],
    }
  }

  return {
    from: 'bun-text',
    to,
    preserved: ALL_FEATURES,
    lost:        [],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_NPM3_BUN_FIXTURES],
  }
}

const CROSS_FAMILY_BUN_OLDER_NPM_CONTRACTS: ConversionContract[] = OLDER_NPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderNpmToBun(format),
    buildCrossFamilyBunToOlderNpm(format),
  ],
)

// === cross-family npm-{1,2} <-> yarn-classic (ADR-0020 Phase E-v) ==========
//
// Older-npm expansion of the classic <-> npm-3 pair:
//
//   npm-2 <-> classic: probe matched the npm-3 pair's honest corpora exactly
//     (`npm-2 -> classic` excludes git; `classic -> npm-2` excludes
//     workspaces-basic).
//
//   npm-1 <-> classic narrows to CROSS_FAMILY_NPM1_CLASSIC_FIXTURES. On that
//     4-fixture corpus:
//       - npm-1 -> classic drops only root `workspacePath` bookkeeping
//         (`workspace-metadata`).
//       - classic -> npm-1 preserves graph state across the narrowed corpus.
function buildCrossFamilyOlderNpmToClassic(from: OlderNpmFormat): ConversionContract {
  if (from === 'npm-1') {
    return {
      from,
      to:   'yarn-classic',
      preserved: withoutFeatures('workspace-membership'),
      lost: [
        {
          feature:    'workspace-metadata',
          diagnostic: 'INTEROP_NPM_1_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
          severity:   'info',
          rationale:  'npm-1 sources stamp the root node with `workspacePath: \'\'` on every fixture; yarn-classic reparses the same NodeIds without `workspacePath` bookkeeping. The graph survives by id, but workspace metadata does not.',
        },
      ],
      added:       [],
      passthrough: [],
      reentrancy:  'asymmetric',
      fixtureSubset: [...CROSS_FAMILY_NPM1_CLASSIC_FIXTURES],
    }
  }

  return {
    from,
    to:   'yarn-classic',
    preserved: withoutFeatures('tarballs', 'workspace-membership'),
    lost: [
      {
        feature:    'workspace-metadata',
        diagnostic: 'INTEROP_NPM_2_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity:   'info',
        rationale:  'npm-2 sources stamp the root node with `workspacePath: \'\'` on every fixture (and workspace fixtures additionally carry member `workspacePath` + `attrs.workspace` edges); yarn-classic reparses the same NodeIds without `workspacePath` / `attrs.workspace` bookkeeping. The workspace graph survives by id, but workspace metadata does not. Mirrors the npm-3 -> classic pair.',
      },
      {
        feature:    'tarballs',
        diagnostic: 'INTEROP_NPM_2_TO_YARN_CLASSIC_TARBALLS_DROPPED',
        severity:   'warning',
        rationale:  'Tarball payload extras drop across the reverse boundary — npm-2 keeps `engines`, `funding`, and `bin` in the per-graph npm sidecar (`_npm-core.ts`), while classic stringify emits only integrity + resolved URL from the graph. Probe matched the npm-3 -> classic loss set: deps-with-scopes (`@sindresorhus/is@6.3.1`: engines + funding), peers-basic / peers-multi (`loose-envify@1.4.0`: bin; `react@18.2.0`, `object-assign@4.1.1`, `react@17.0.2`: engines), and yarn-crlf (`is-buffer@2.0.5`: engines + funding).',
      },
    ],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: [...CROSS_FAMILY_NPM3_CLASSIC_FIXTURES],
  }
}

function buildCrossFamilyClassicToOlderNpm(to: OlderNpmFormat): ConversionContract {
  return {
    from: 'yarn-classic',
    to,
    preserved: ALL_FEATURES,
    lost:        [],
    added:       [],
    passthrough: [],
    reentrancy:  'asymmetric',
    fixtureSubset: to === 'npm-1'
      ? [...CROSS_FAMILY_NPM1_CLASSIC_FIXTURES]
      : [...CROSS_FAMILY_CLASSIC_NPM3_FIXTURES],
  }
}

const CROSS_FAMILY_CLASSIC_OLDER_NPM_CONTRACTS: ConversionContract[] = OLDER_NPM_FORMATS.flatMap(
  format => [
    buildCrossFamilyOlderNpmToClassic(format),
    buildCrossFamilyClassicToOlderNpm(format),
  ],
)

// TODO(adr-0020): ADR-0018 explicitly deferred compressionLevel, but the
// current core preserves unknown __metadata extras across the whole berry
// family. The interop contracts therefore pin observed passthrough behavior
// instead of the dispatch brief's v8/v9-only assumption.
const RAW_CONTRACTS: ConversionContract[] = [
  ...BERRY_BERRY_CONTRACTS,
  ...BERRY_FORMATS.map(buildClassicToBerry),
  ...BERRY_FORMATS.map(buildBerryToClassic),
  ...NPM_INTRA_CONTRACTS,
  ...PNPM_INTRA_CONTRACTS,
  ...CROSS_FAMILY_YB9_PNPM9_CONTRACTS,
  ...CROSS_FAMILY_YB4_PNPM9_CONTRACTS,
  ...CROSS_FAMILY_YB_MID_PNPM9_CONTRACTS,
  ...CROSS_FAMILY_YB9_OLDER_PNPM_CONTRACTS,
  ...CROSS_FAMILY_YB9_NPM3_CONTRACTS,
  ...CROSS_FAMILY_YB4_NPM3_CONTRACTS,
  ...CROSS_FAMILY_YB_MID_NPM3_CONTRACTS,
  ...CROSS_FAMILY_PNPM9_NPM3_CONTRACTS,
  ...CROSS_FAMILY_OLDER_PNPM_NPM3_CONTRACTS,
  ...CROSS_FAMILY_CLASSIC_PNPM9_CONTRACTS,
  ...CROSS_FAMILY_CLASSIC_OLDER_PNPM_CONTRACTS,
  ...CROSS_FAMILY_CLASSIC_NPM3_CONTRACTS,
  ...CROSS_FAMILY_CLASSIC_BUN_CONTRACTS,
  ...CROSS_FAMILY_YB9_BUN_CONTRACTS,
  ...CROSS_FAMILY_YB_OLDER_BUN_CONTRACTS,
  ...CROSS_FAMILY_PNPM9_BUN_CONTRACTS,
  ...CROSS_FAMILY_OLDER_PNPM_BUN_CONTRACTS,
  ...CROSS_FAMILY_NPM3_BUN_CONTRACTS,
  ...CROSS_FAMILY_YB9_OLDER_NPM_CONTRACTS,
  ...CROSS_FAMILY_PNPM9_OLDER_NPM_CONTRACTS,
  ...CROSS_FAMILY_BUN_OLDER_NPM_CONTRACTS,
  ...CROSS_FAMILY_CLASSIC_OLDER_NPM_CONTRACTS,
]

// ADR-0031 — integrity is origin-scoped: a tarball SRI (npm / pnpm / bun /
// yarn-classic) and a yarn-berry zip-cache `checksum` are digests of DIFFERENT
// artefacts. A conversion that crosses the berry ↔ non-berry boundary cannot
// carry the source's integrity offline — it is omitted + a
// `RECIPE_INTEGRITY_INCOMPLETE` diagnostic, never fabricated — so `integrity` is
// not a preserved feature on those cells. `tarballs` STAYS preserved: the
// graphSubset payload deep-equal excludes integrity (`stripVolatile`), so it
// keeps verifying engines/os/cpu/license/bin/bundledDeps fidelity across the
// boundary. Within an origin class (berry ↔ berry, or among the SRI family)
// integrity round-trips and stays preserved. Idempotent for cells that already
// dropped integrity for another reason.
const isBerryFormat = (f: FormatId): boolean => f.startsWith('yarn-berry')
const crossesOriginClass = (a: FormatId, b: FormatId): boolean => isBerryFormat(a) !== isBerryFormat(b)

export const CONTRACTS: ConversionContract[] = RAW_CONTRACTS.map(contract =>
  crossesOriginClass(contract.from, contract.to)
    ? { ...contract, preserved: contract.preserved.filter(f => f !== 'integrity') }
    : contract,
)
