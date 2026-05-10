export type FormatId =
  | 'yarn-berry-v4'
  | 'yarn-berry-v5'
  | 'yarn-berry-v6'
  | 'yarn-berry-v8'
  | 'yarn-berry-v9'
  | 'yarn-classic'
  | 'npm-1'
  | 'npm-2'
  | 'npm-3'
  | 'pnpm-v5'
  | 'pnpm-v6'
  | 'pnpm-v9'
  | 'bun-text'

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

export type LossEntry = {
  feature: string
  diagnostic: string
  severity: 'warning' | 'info'
  rationale: string
}

export type AdditionEntry = {
  field: string
  source: 'static' | 'caller-option' | 'manifest-derived' | 'enrich-synthesized'
  diagnostic?: string
  severity?: 'warning' | 'info'
  rationale: string
}

export type PassthroughEntry = {
  feature: string
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

// Shared berry corpus across v4/v5/v6/v8 pairs:
// - bundled-deps excluded because no yarn-berry fixture exists on disk
// - patch-yarn excluded because only yarn-berry-v9.lock exists on disk
// - workspace-cross-refs excluded because yarn-berry-v4.lock is absent
const BERRY_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Shared berry corpus for v9<->v4 pairs:
// - bundled-deps excluded because no yarn-berry fixture exists on disk
// - patch-yarn excluded because only yarn-berry-v9.lock exists on disk
// - workspace-cross-refs excluded because yarn-berry-v4.lock is absent
// - git-github-tarball excluded because yarn-berry-v9.lock is absent
const BERRY_SHARED_NO_GIT_FOR_V9 = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Workspace-focused berry corpus for v5/v6/v8/v9 pairs:
// - bundled-deps excluded because no yarn-berry fixture exists on disk
// - patch-yarn excluded because only yarn-berry-v9.lock exists on disk
// - git-github-tarball excluded because yarn-berry-v9.lock is absent and the
//   fixture carries no workspace signal for workspace-membership assertions
const BERRY_WORKSPACE_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Classic-compatible shared corpus:
// - bundled-deps excluded because no yarn-classic fixture exists on disk
// - patch-yarn excluded because yarn-classic cannot represent patch slots;
//   patch-yarn excluded - patch-loss path covered by synthetic graph
//   (cross-family/yarn-berry-to-yarn-classic.test.ts:97-157), TODO
//   real-fixture coverage tracked under `interop-real-diagnostic-emission` stub
// - workspace-cross-refs excluded because no yarn-classic fixture exists on disk
const CLASSIC_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// TODO(adr-0020): ADR-0018 explicitly deferred compressionLevel, but the
// current core preserves unknown __metadata extras across the whole berry
// family. The interop contracts therefore pin observed passthrough behavior
// instead of the dispatch brief's v8/v9-only assumption.
export const CONTRACTS: ConversionContract[] = [
  {
    from: 'yarn-berry-v9',
    to: 'yarn-berry-v8',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V8_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v8 and v9 both preserve the conditions sidecar verbatim',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V8_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V9_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v8 and v9 both preserve the conditions sidecar verbatim',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V9_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v9',
    to: 'yarn-berry-v6',
    preserved: withoutFeatures('integrity', 'tarballs'),
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V6_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v6 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V6_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v6',
    to: 'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V9_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v6 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V9_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v9',
    to: 'yarn-berry-v5',
    preserved: withoutFeatures('integrity', 'tarballs'),
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V5_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V5_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v5',
    to: 'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V9_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V9_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v9',
    to: 'yarn-berry-v4',
    preserved: withoutFeatures('integrity', 'tarballs', 'conditions'),
    lost: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V4_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'v4 stringifier warns and drops conditions blocks',
      },
    ],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_BERRY_V4_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_SHARED_NO_GIT_FOR_V9],
  },
  {
    from: 'yarn-berry-v4',
    to: 'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_BERRY_V9_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_SHARED_NO_GIT_FOR_V9],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-berry-v6',
    preserved: withoutFeatures('integrity', 'tarballs'),
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V6_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v6 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V6_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v6',
    to: 'yarn-berry-v8',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V8_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v6 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V8_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-berry-v5',
    preserved: withoutFeatures('integrity', 'tarballs'),
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V5_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V5_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v5',
    to: 'yarn-berry-v8',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V8_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 already carries conditions blocks unchanged',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V8_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-berry-v4',
    preserved: withoutFeatures('integrity', 'tarballs', 'conditions'),
    lost: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V4_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'v4 stringifier warns and drops conditions blocks',
      },
    ],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_BERRY_V4_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v4',
    to: 'yarn-berry-v8',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_BERRY_V8_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v6',
    to: 'yarn-berry-v5',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V5_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 and v6 both preserve conditions blocks',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V5_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v5',
    to: 'yarn-berry-v6',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V6_CONDITIONS_PASSTHROUGH',
        severity: 'info',
        rationale: 'v5 and v6 both preserve conditions blocks',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V6_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_WORKSPACE_FIXTURES],
  },
  {
    from: 'yarn-berry-v6',
    to: 'yarn-berry-v4',
    preserved: withoutFeatures('conditions'),
    lost: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V4_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'v4 stringifier warns and drops conditions blocks',
      },
    ],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_BERRY_V4_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v4',
    to: 'yarn-berry-v6',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_BERRY_V6_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v5',
    to: 'yarn-berry-v4',
    preserved: withoutFeatures('conditions'),
    lost: [
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V4_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'v4 stringifier warns and drops conditions blocks',
      },
    ],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_BERRY_V4_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'one-way-lossy',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v4',
    to: 'yarn-berry-v5',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_BERRY_V5_COMPRESSIONLEVEL_PASSTHROUGH',
        severity: 'info',
        rationale: 'runtime preserves compressionLevel as opaque __metadata',
      },
    ],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [...BERRY_SHARED_FIXTURES],
  },
  {
    from: 'yarn-classic',
    to: 'yarn-berry-v4',
    preserved: ['nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership'],
    lost: [],
    added: [
      {
        field: '__metadata.version',
        source: 'static',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V4_PREAMBLE_SYNTHESIZED',
        severity: 'info',
        rationale: 'berry outputs always synthesize a __metadata.version preamble',
      },
      {
        field: 'workspace metadata',
        source: 'manifest-derived',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V4_WORKSPACE_SYNTHESIZED',
        severity: 'info',
        rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
      },
    ],
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-classic',
    to: 'yarn-berry-v5',
    preserved: ['nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership'],
    lost: [],
    added: [
      {
        field: '__metadata.version',
        source: 'static',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V5_PREAMBLE_SYNTHESIZED',
        severity: 'info',
        rationale: 'berry outputs always synthesize a __metadata.version preamble',
      },
      {
        field: 'workspace metadata',
        source: 'manifest-derived',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V5_WORKSPACE_SYNTHESIZED',
        severity: 'info',
        rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
      },
      {
        field: 'conditions default',
        source: 'static',
        rationale: 'v5 can carry conditions but the current conversion path leaves them absent',
      },
    ],
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-classic',
    to: 'yarn-berry-v6',
    preserved: ['nodes', 'edges', 'edge-kinds', 'resolved-url', 'workspace-membership'],
    lost: [],
    added: [
      {
        field: '__metadata.version',
        source: 'static',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V6_PREAMBLE_SYNTHESIZED',
        severity: 'info',
        rationale: 'berry outputs always synthesize a __metadata.version preamble',
      },
      {
        field: 'workspace metadata',
        source: 'manifest-derived',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V6_WORKSPACE_SYNTHESIZED',
        severity: 'info',
        rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
      },
      {
        field: 'conditions default',
        source: 'static',
        rationale: 'v6 can carry conditions but the current conversion path leaves them absent',
      },
    ],
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-classic',
    to: 'yarn-berry-v8',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'workspace-membership'],
    lost: [],
    added: [
      {
        field: '__metadata.version',
        source: 'static',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V8_PREAMBLE_SYNTHESIZED',
        severity: 'info',
        rationale: 'berry outputs always synthesize a __metadata.version preamble',
      },
      {
        field: 'workspace metadata',
        source: 'manifest-derived',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V8_WORKSPACE_SYNTHESIZED',
        severity: 'info',
        rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
      },
      {
        field: 'conditions default',
        source: 'static',
        rationale: 'v8 can carry conditions but the current conversion path leaves them absent',
      },
      {
        field: 'compressionLevel default',
        source: 'static',
        rationale: 'v8 can carry compressionLevel but the current conversion path leaves it absent',
      },
    ],
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-classic',
    to: 'yarn-berry-v9',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs', 'workspace-membership'],
    lost: [],
    added: [
      {
        field: '__metadata.version',
        source: 'static',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V9_PREAMBLE_SYNTHESIZED',
        severity: 'info',
        rationale: 'berry outputs always synthesize a __metadata.version preamble',
      },
      {
        field: 'workspace metadata',
        source: 'manifest-derived',
        diagnostic: 'INTEROP_YARN_CLASSIC_TO_YARN_BERRY_V9_WORKSPACE_SYNTHESIZED',
        severity: 'info',
        rationale: 'workspace root and workspace attrs are synthesized only in enrich-aware mode',
      },
      {
        field: 'conditions default',
        source: 'static',
        rationale: 'v9 can carry conditions but the current conversion path leaves them absent',
      },
      {
        field: 'compressionLevel default',
        source: 'static',
        rationale: 'v9 can carry compressionLevel but the current conversion path leaves it absent',
      },
    ],
    passthrough: [],
    reentrancy: 'asymmetric',
    enrichRequired: ['manifests'],
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v4',
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost: [
      {
        feature: 'peer-virt',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity: 'warning',
        rationale: 'classic flattens peerContext away on emit',
      },
      {
        feature: 'patch',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity: 'warning',
        rationale: 'classic cannot encode patch slots',
      },
      {
        feature: 'virtual',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_VIRTUAL_DROPPED',
        severity: 'warning',
        rationale: 'classic has no virtual key space',
      },
      {
        feature: 'workspace-metadata',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity: 'info',
        rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
      {
        feature: 'cacheKey',
        diagnostic: 'INTEROP_YARN_BERRY_V4_TO_YARN_CLASSIC_CACHEKEY_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v5',
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost: [
      {
        feature: 'peer-virt',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity: 'warning',
        rationale: 'classic flattens peerContext away on emit',
      },
      {
        feature: 'patch',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity: 'warning',
        rationale: 'classic cannot encode patch slots',
      },
      {
        feature: 'virtual',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_VIRTUAL_DROPPED',
        severity: 'warning',
        rationale: 'classic has no virtual key space',
      },
      {
        feature: 'workspace-metadata',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity: 'info',
        rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
      },
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'classic has no conditions field',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
      {
        feature: 'cacheKey',
        diagnostic: 'INTEROP_YARN_BERRY_V5_TO_YARN_CLASSIC_CACHEKEY_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v6',
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost: [
      {
        feature: 'peer-virt',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity: 'warning',
        rationale: 'classic flattens peerContext away on emit',
      },
      {
        feature: 'patch',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity: 'warning',
        rationale: 'classic cannot encode patch slots',
      },
      {
        feature: 'virtual',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_VIRTUAL_DROPPED',
        severity: 'warning',
        rationale: 'classic has no virtual key space',
      },
      {
        feature: 'workspace-metadata',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity: 'info',
        rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
      },
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'classic has no conditions field',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
      {
        feature: 'cacheKey',
        diagnostic: 'INTEROP_YARN_BERRY_V6_TO_YARN_CLASSIC_CACHEKEY_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost: [
      {
        feature: 'peer-virt',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity: 'warning',
        rationale: 'classic flattens peerContext away on emit',
      },
      {
        feature: 'patch',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity: 'warning',
        rationale: 'classic cannot encode patch slots',
      },
      {
        feature: 'virtual',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_VIRTUAL_DROPPED',
        severity: 'warning',
        rationale: 'classic has no virtual key space',
      },
      {
        feature: 'workspace-metadata',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity: 'info',
        rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
      },
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'classic has no conditions field',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
      {
        feature: 'cacheKey',
        diagnostic: 'INTEROP_YARN_BERRY_V8_TO_YARN_CLASSIC_CACHEKEY_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
  {
    from: 'yarn-berry-v9',
    to: 'yarn-classic',
    preserved: ['nodes', 'edges', 'edge-kinds', 'integrity', 'resolved-url', 'tarballs'],
    lost: [
      {
        feature: 'peer-virt',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_PEER_VIRT_DROPPED',
        severity: 'warning',
        rationale: 'classic flattens peerContext away on emit',
      },
      {
        feature: 'patch',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_PATCH_DROPPED',
        severity: 'warning',
        rationale: 'classic cannot encode patch slots',
      },
      {
        feature: 'virtual',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_VIRTUAL_DROPPED',
        severity: 'warning',
        rationale: 'classic has no virtual key space',
      },
      {
        feature: 'workspace-metadata',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED',
        severity: 'info',
        rationale: 'classic omits root workspace metadata and attrs.workspace boundaries',
      },
      {
        feature: 'conditions',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_CONDITIONS_DROPPED',
        severity: 'warning',
        rationale: 'classic has no conditions field',
      },
      {
        feature: 'compressionLevel',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
      {
        feature: 'cacheKey',
        diagnostic: 'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_CACHEKEY_DROPPED',
        severity: 'info',
        rationale: 'classic has no __metadata section',
      },
    ],
    added: [],
    passthrough: [],
    reentrancy: 'asymmetric',
    fixtureSubset: [...CLASSIC_SHARED_FIXTURES],
  },
]
