import type { EdgeKind, PackageMetadataField } from '../graph.ts'
import type { FormatId } from '../api/format-contract.ts'
import {
  PACKAGE_METADATA_FIELDS,
} from '../registry/payload.ts'
import type {
  ResolvedTargetCapabilities,
  TargetCapability,
  TargetManager,
  TargetProfile,
  TargetRequest,
} from './types.ts'

interface ManagerVersion {
  major: number
  minor?: number
  patch?: number
  prerelease?: string
}

const versionPattern = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(value: string): ManagerVersion {
  const match = value.match(versionPattern)
  if (match === null) throw new TypeError(`invalid target manager version ${JSON.stringify(value)}`)
  return {
    major: Number(match[1]),
    ...(match[2] === undefined ? {} : { minor: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { patch: Number(match[3]) }),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  }
}

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values)
  let view: ReadonlySet<T>
  view = Object.freeze({
    get size() { return set.size },
    has: (value: T) => set.has(value),
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    forEach: (callback: (value: T, key: T, source: ReadonlySet<T>) => void, thisArg?: unknown) => {
      set.forEach(value => callback.call(thisArg, value, value, view))
    },
    [Symbol.iterator]: () => set[Symbol.iterator](),
  })
  return view
}

const edges = (...kinds: EdgeKind[]): ReadonlySet<EdgeKind> => readonlySet(kinds)
const metadata = (...fields: PackageMetadataField[]): ReadonlySet<PackageMetadataField> => readonlySet(fields)

function targetManagerOf(format: FormatId): TargetManager {
  if (format.startsWith('npm-')) return 'npm'
  if (format.startsWith('yarn-')) return 'yarn'
  if (format.startsWith('pnpm-')) return 'pnpm'
  if (format === 'bun-text') return 'bun'
  return 'lockgraph'
}

function capabilities(
  value: ResolvedTargetCapabilities,
): Readonly<ResolvedTargetCapabilities> {
  return Object.freeze(value)
}

const npm1 = capabilities({
  edgeKinds: edges('dep', 'dev', 'optional', 'bundled'),
  workspaces: false,
  workspaceProtocol: false,
  peerRepresentation: 'none',
  patches: false,
  bundledDependencies: true,
  conditions: false,
  catalogs: false,
  integrity: 'tarball-sri',
  layout: 'generated',
  lockOverridesCarrier: false,
  overridesConfigLocation: 'none',
  comparesOverridesInFrozen: false,
  overridesGrammar: 'none',
  metadataFields: metadata(),
})

const npm3 = capabilities({
  ...npm1,
  edgeKinds: edges('dep', 'dev', 'optional', 'peer', 'bundled'),
  workspaces: true,
  peerRepresentation: 'declared',
  overridesConfigLocation: 'manifest',
  overridesGrammar: 'npm-nested',
  metadataFields: metadata(
    'engines',
    'funding',
    'license',
    'bin',
    'deprecated',
    'cpu',
    'os',
    'libc',
    'hasInstallScript',
    'peerDependencies',
    'peerDependenciesMeta',
  ),
})

const yarnClassic = capabilities({
  edgeKinds: edges('dep', 'optional'),
  workspaces: true,
  workspaceProtocol: false,
  peerRepresentation: 'none',
  patches: false,
  bundledDependencies: false,
  conditions: false,
  catalogs: false,
  integrity: 'tarball-sri',
  layout: 'none',
  lockOverridesCarrier: false,
  overridesConfigLocation: 'manifest',
  comparesOverridesInFrozen: false,
  overridesGrammar: 'yarn-selective',
  metadataFields: metadata(),
})

function yarnBerry(format: FormatId): Readonly<ResolvedTargetCapabilities> {
  return capabilities({
    edgeKinds: edges('dep', 'dev', 'optional', 'peer'),
    workspaces: true,
    workspaceProtocol: true,
    peerRepresentation: 'virtualized',
    patches: true,
    bundledDependencies: false,
    conditions: format !== 'yarn-berry-v4',
    catalogs: format === 'yarn-berry-v8'
      || format === 'yarn-berry-v9'
      || format === 'yarn-berry-v10',
    integrity: 'berry-zip',
    layout: 'none',
    lockOverridesCarrier: false,
    overridesConfigLocation: 'manifest',
    comparesOverridesInFrozen: false,
    overridesGrammar: 'yarn-selective',
    metadataFields: format === 'yarn-berry-v4'
      ? metadata('bin', 'peerDependencies', 'peerDependenciesMeta')
      : metadata('bin', 'cpu', 'os', 'libc', 'peerDependencies', 'peerDependenciesMeta'),
  })
}

function pnpm(
  patches: boolean,
  lockOverridesCarrier: boolean,
  comparesOverridesInFrozen: boolean,
  overridesConfigLocation: ResolvedTargetCapabilities['overridesConfigLocation'],
  catalogs: boolean,
  metadataFields: ReadonlySet<PackageMetadataField>,
): Readonly<ResolvedTargetCapabilities> {
  return capabilities({
    edgeKinds: edges('dep', 'dev', 'optional', 'peer'),
    workspaces: true,
    workspaceProtocol: true,
    peerRepresentation: 'virtualized',
    patches,
    bundledDependencies: false,
    conditions: false,
    catalogs,
    integrity: 'tarball-sri',
    layout: 'none',
    lockOverridesCarrier,
    overridesConfigLocation,
    comparesOverridesInFrozen,
    overridesGrammar: 'pnpm-flat',
    metadataFields,
  })
}

const pnpmV5Metadata = metadata('engines', 'bin', 'cpu', 'os', 'peerDependencies')
const pnpmModernMetadata = metadata(
  'engines',
  'bin',
  'deprecated',
  'cpu',
  'os',
  'libc',
  'peerDependencies',
  'peerDependenciesMeta',
)

const pnpmV6 = pnpm(true, true, true, 'manifest', false, pnpmModernMetadata)

const bunText = capabilities({
  edgeKinds: edges('dep', 'dev', 'optional', 'peer'),
  workspaces: true,
  workspaceProtocol: true,
  peerRepresentation: 'declared',
  patches: false,
  bundledDependencies: false,
  conditions: false,
  catalogs: false,
  integrity: 'tarball-sri',
  layout: 'none',
  lockOverridesCarrier: true,
  overridesConfigLocation: 'manifest',
  comparesOverridesInFrozen: true,
  overridesGrammar: 'bun-flat',
  metadataFields: metadata('bin', 'cpu', 'os', 'peerDependencies'),
})

const lockgraph = capabilities({
  edgeKinds: edges('dep', 'dev', 'optional', 'peer', 'bundled'),
  workspaces: true,
  workspaceProtocol: true,
  peerRepresentation: 'virtualized',
  patches: true,
  bundledDependencies: true,
  conditions: true,
  catalogs: false,
  integrity: 'canonical',
  layout: 'encoded',
  lockOverridesCarrier: false,
  overridesConfigLocation: 'none',
  comparesOverridesInFrozen: false,
  overridesGrammar: 'none',
  metadataFields: metadata(...PACKAGE_METADATA_FIELDS),
})

function assertCompatible(format: FormatId, version: ManagerVersion | undefined): void {
  if (version === undefined) return
  const major = version.major
  const minor = version.minor
  const yarnCompatible =
    format === 'yarn-berry-v4' ? major >= 2
      : format === 'yarn-berry-v5' ? major > 3 || (major === 3 && (minor ?? -1) >= 1)
        : format === 'yarn-berry-v6' ? major > 3 || (major === 3 && (minor ?? -1) >= 2)
          : format === 'yarn-berry-v7' ? yarnV7Compatible(version)
            : format === 'yarn-berry-v8' ? major >= 4 && version.prerelease === undefined
              : format === 'yarn-berry-v9' ? major > 4
                || (major === 4 && (minor ?? -1) >= 14 && version.prerelease === undefined)
                : format === 'yarn-berry-v10' ? major >= 5
                  : false
  const compatible =
    format === 'npm-1' ? major >= 5 && major <= 6
      : format === 'npm-2' ? major >= 7 && major <= 8
        : format === 'npm-3' ? major >= 9
          : format === 'yarn-classic' ? major === 1
            : format === 'pnpm-v5' ? major >= 3 && major <= 7
              : format === 'pnpm-v6' ? major === 8
                : format === 'pnpm-v9' ? major >= 9
                  : format === 'bun-text' ? major > 1 || (major === 1 && (minor ?? -1) >= 2)
                    : format === 'lockgraph' ? false
                      : yarnCompatible
  if (!compatible) throw new TypeError(`target manager version is incompatible with ${format}`)
}

function yarnV7Compatible(version: ManagerVersion): boolean {
  if (version.major > 4) return true
  if (version.major < 4) return false
  if (version.prerelease === undefined) return true
  const match = version.prerelease.match(/^rc\.(\d+)$/)
  return match !== null && Number(match[1]) >= 27
}

function pnpmV5(
  version: ManagerVersion | undefined,
): { capabilities: Readonly<ResolvedTargetCapabilities>; ambiguous: readonly TargetCapability[] } {
  if (version === undefined) {
    return {
      capabilities: pnpm(false, false, false, 'manifest', false, pnpmV5Metadata),
      ambiguous: ['lockOverridesCarrier', 'comparesOverridesInFrozen'],
    }
  }
  const carriesOverrides = version.major >= 6
  return {
    capabilities: pnpm(false, carriesOverrides, carriesOverrides, 'manifest', false, pnpmV5Metadata),
    ambiguous: [],
  }
}

function npmV2(
  version: ManagerVersion | undefined,
): { capabilities: Readonly<ResolvedTargetCapabilities>; ambiguous: readonly TargetCapability[] } {
  const supportsOverrides = version?.major === 8
    && version.minor !== undefined
    && version.minor >= 3
  const ambiguous = version === undefined || (version.major === 8 && version.minor === undefined)
    ? ['overridesConfigLocation', 'overridesGrammar'] as const
    : []
  return {
    capabilities: capabilities({
      ...npm3,
      overridesConfigLocation: supportsOverrides ? 'manifest' : 'none',
      overridesGrammar: supportsOverrides ? 'npm-nested' : 'none',
    }),
    ambiguous,
  }
}

function pnpmV9(
  version: ManagerVersion | undefined,
): { capabilities: Readonly<ResolvedTargetCapabilities>; ambiguous: readonly TargetCapability[] } {
  const catalogs = version === undefined
    ? false
    : version.major > 9 || (version.major === 9 && (version.minor ?? 0) >= 5)
  const configLocation = version !== undefined && version.major >= 11
    ? 'workspace-yaml'
    : 'manifest'
  const ambiguous: TargetCapability[] = []
  if (version === undefined || (version.major === 9 && version.minor === undefined)) {
    ambiguous.push('catalogs')
  }
  if (version === undefined) ambiguous.push('overridesConfigLocation')
  return {
    capabilities: pnpm(true, true, true, configLocation, catalogs, pnpmModernMetadata),
    ambiguous,
  }
}

function resolvedCapabilities(
  format: FormatId,
  version: ManagerVersion | undefined,
): { capabilities: Readonly<ResolvedTargetCapabilities>; ambiguous: readonly TargetCapability[] } {
  switch (format) {
    case 'npm-1': return { capabilities: npm1, ambiguous: [] }
    case 'npm-2': return npmV2(version)
    case 'npm-3': return { capabilities: npm3, ambiguous: [] }
    case 'yarn-classic': return { capabilities: yarnClassic, ambiguous: [] }
    case 'yarn-berry-v4':
    case 'yarn-berry-v5':
    case 'yarn-berry-v6':
    case 'yarn-berry-v7':
    case 'yarn-berry-v8':
    case 'yarn-berry-v9':
    case 'yarn-berry-v10': return { capabilities: yarnBerry(format), ambiguous: [] }
    case 'pnpm-v5': return pnpmV5(version)
    case 'pnpm-v6': return { capabilities: pnpmV6, ambiguous: [] }
    case 'pnpm-v9': return pnpmV9(version)
    case 'bun-text': return { capabilities: bunText, ambiguous: [] }
    case 'lockgraph': return { capabilities: lockgraph, ambiguous: [] }
  }
}

export function targetProfileOf(request: TargetRequest): TargetProfile {
  const version = request.managerVersion === undefined ? undefined : parseVersion(request.managerVersion)
  assertCompatible(request.format, version)
  const resolved = resolvedCapabilities(request.format, version)
  return Object.freeze({
    manager: targetManagerOf(request.format),
    format: request.format,
    ...(request.managerVersion === undefined ? {} : { managerVersion: request.managerVersion }),
    capabilities: resolved.capabilities,
    ambiguousCapabilities: readonlySet(resolved.ambiguous),
    provenance: 'builtin',
  })
}
