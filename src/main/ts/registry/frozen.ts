import semver from 'semver'
import type { Graph, Node, TarballPayload } from '../graph.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from './types.ts'

interface IndexedVersion {
  readonly version: PackumentVersion
  readonly bundledDependencies: Set<string>
}

type VersionMap = Map<string, IndexedVersion>

export function frozenRegistry(graph: Graph): RegistryAdapter {
  const byName = new Map<string, VersionMap>()

  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue

    const versions = ensureVersionMap(byName, node.name)
    const indexed = versions.get(node.version) ?? createIndexedVersion(node, graph.tarballOf(node.id))

    mergePayload(indexed.version, graph.tarballOf(node.id))
    mergeEdges(indexed, node, graph)

    versions.set(node.version, indexed)
  }

  const packuments = new Map<string, Packument>()
  for (const [name, versions] of byName) {
    const ordered = Array.from(versions.values(), item => finaliseIndexedVersion(item))
      .sort(comparePackumentVersionsDesc)

    const versionMap: Record<string, PackumentVersion> = {}
    for (const version of ordered) versionMap[version.version] = version

    packuments.set(name, {
      name,
      distTags: ordered.length === 0 ? {} : { latest: ordered[0]!.version },
      versions: versionMap,
    })
  }

  return {
    async packument(name) {
      return packuments.get(name)
    },
    async resolve(name, range) {
      const packument = packuments.get(name)
      if (packument === undefined) return undefined

      const versions = Object.values(packument.versions).sort(comparePackumentVersionsDesc)
      const exact = versions.find(version => version.version === range)
      if (exact !== undefined) return exact

      const tagged = packument.distTags[range]
      if (tagged !== undefined) return packument.versions[tagged]

      try {
        const resolved = semver.maxSatisfying(versions.map(version => version.version), range)
        return resolved === null ? undefined : packument.versions[resolved]
      } catch {
        return undefined
      }
    },
  }
}

function ensureVersionMap(byName: Map<string, VersionMap>, name: string): VersionMap {
  const existing = byName.get(name)
  if (existing !== undefined) return existing
  const created: VersionMap = new Map()
  byName.set(name, created)
  return created
}

function createIndexedVersion(node: Node, tarball: TarballPayload | undefined): IndexedVersion {
  return {
    version: {
      name:       node.name,
      version:    node.version,
      integrity:  tarball?.integrity,
      tarball:    tarball?.resolution?.type === 'tarball' ? tarball.resolution.url : undefined,
      engines:    tarball?.engines,
      os:         tarball?.os,
      cpu:        tarball?.cpu,
      libc:       tarball?.libc,
      deprecated: tarball?.deprecated,
      bin:        tarball?.bin,
    },
    bundledDependencies: new Set(tarball?.bundledDependencies ?? []),
  }
}

function mergePayload(target: PackumentVersion, tarball: TarballPayload | undefined): void {
  if (tarball === undefined) return
  if (target.integrity === undefined) target.integrity = tarball.integrity
  if (target.tarball === undefined && tarball.resolution?.type === 'tarball') {
    target.tarball = tarball.resolution.url
  }
  if (target.engines === undefined && tarball.engines !== undefined) target.engines = tarball.engines
  if (target.os === undefined && tarball.os !== undefined) target.os = tarball.os
  if (target.cpu === undefined && tarball.cpu !== undefined) target.cpu = tarball.cpu
  if (target.libc === undefined && tarball.libc !== undefined) target.libc = tarball.libc
  if (target.deprecated === undefined) target.deprecated = tarball.deprecated
  if (target.bin === undefined) target.bin = tarball.bin
}

function mergeEdges(target: IndexedVersion, node: Node, graph: Graph): void {
  for (const edge of graph.out(node.id)) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const range = edge.attrs?.range ?? dst.version

    switch (edge.kind) {
      case 'dep':
        upsertDependency(target.version, 'dependencies', dst.name, range)
        break
      case 'dev':
        upsertDependency(target.version, 'devDependencies', dst.name, range)
        break
      case 'optional':
        upsertDependency(target.version, 'optionalDependencies', dst.name, range)
        break
      case 'peer':
        upsertDependency(target.version, 'peerDependencies', dst.name, range)
        break
      case 'bundled':
        target.bundledDependencies.add(dst.name)
        break
    }
  }
}

function upsertDependency(
  version: PackumentVersion,
  field: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies',
  name: string,
  range: string,
): void {
  const block = version[field] ?? {}
  if (block[name] === undefined) block[name] = range
  version[field] = block
}

function finaliseIndexedVersion(indexed: IndexedVersion): PackumentVersion {
  const bundledDependencies = Array.from(indexed.bundledDependencies).sort(compareStrings)
  return bundledDependencies.length === 0
    ? indexed.version
    : { ...indexed.version, bundledDependencies }
}

function comparePackumentVersionsDesc(a: PackumentVersion, b: PackumentVersion): number {
  const validA = semver.valid(a.version)
  const validB = semver.valid(b.version)
  if (validA !== null && validB !== null) return semver.rcompare(a.version, b.version)
  if (validA !== null) return -1
  if (validB !== null) return 1
  return compareStrings(b.version, a.version)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
