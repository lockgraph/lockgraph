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

export const CONTRACTS: ConversionContract[] = [
  {
    from: 'yarn-berry-v9',
    to: 'yarn-berry-v8',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [],
    reentrancy: 'lossless-reentrant',
    fixtureSubset: [
      'deps-with-scopes',
      'peers-basic',
      'peers-multi',
      'simple',
      'workspace-cross-refs',
      'workspaces-basic',
      'yarn-crlf',
    ],
  },
  {
    from: 'yarn-berry-v8',
    to: 'yarn-berry-v9',
    preserved: ALL_FEATURES,
    lost: [],
    added: [],
    passthrough: [],
    reentrancy: 'lossless-reentrant',
  },
]
