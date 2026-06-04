// Shared builders for modify-* / complete-* / find-up tests.
//
// Mirrors the registry-frozen.test.ts addPackage helper but exposes a
// composable builder that the modify suites reuse.

import {
  newBuilder,
  serializeNodeId,
  type Builder,
  type EdgeKind,
  type Graph,
  type NodeId,
} from '../../main/ts/graph.ts'
import { mkIntegrity } from '../_integrity-fixtures.ts'

export function graphOf(build: (builder: Builder) => void): Graph {
  const builder = newBuilder()
  build(builder)
  return builder.seal()
}

export interface AddPackageOpts {
  name:           string
  version:        string
  peerContext?:   NodeId[]
  workspacePath?: string
  patch?:         string
  integrity?:     string
  tarball?:       string
  engines?:       Record<string, string>
  os?:            string[]
  cpu?:           string[]
  libc?:          string[]
  deprecated?:    string
  bin?:           string | Record<string, string>
  bundledDeps?:   string[]
  license?:       string
}

export function addPackage(builder: Builder, opts: AddPackageOpts): NodeId {
  const peerContext = opts.peerContext ?? []
  const id = serializeNodeId(opts.name, opts.version, peerContext, opts.patch)
  builder.addNode({
    id,
    name:          opts.name,
    version:       opts.version,
    peerContext,
    patch:         opts.patch,
    workspacePath: opts.workspacePath,
  })
  if (
    opts.integrity !== undefined
    || opts.tarball !== undefined
    || opts.engines !== undefined
    || opts.os !== undefined
    || opts.cpu !== undefined
    || opts.libc !== undefined
    || opts.deprecated !== undefined
    || opts.bin !== undefined
    || opts.bundledDeps !== undefined
    || opts.license !== undefined
  ) {
    builder.setTarball(
      { name: opts.name, version: opts.version, patch: opts.patch },
      {
        integrity:           opts.integrity === undefined ? undefined : mkIntegrity(opts.integrity),
        engines:             opts.engines,
        os:                  opts.os,
        cpu:                 opts.cpu,
        libc:                opts.libc,
        deprecated:          opts.deprecated,
        bin:                 opts.bin,
        bundledDependencies: opts.bundledDeps,
        license:             opts.license,
        resolution:          opts.tarball === undefined ? undefined : { type: 'tarball', url: opts.tarball },
      },
    )
  }
  return id
}

export function addEdge(
  builder: Builder,
  src: NodeId,
  dst: NodeId,
  kind: EdgeKind,
  range?: string,
): void {
  builder.addEdge(src, dst, kind, range === undefined ? undefined : { range })
}
