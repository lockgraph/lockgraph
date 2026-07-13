import {
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type Graph,
  type Node,
  type TarballKey,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import {
  normalizePackageManifestEvidence,
} from '../completeness/evidence.ts'
import { packageMetadataDiagnostic } from '../completeness/diagnostics.ts'
import type { PackageManifestEvidence } from '../completeness/types.ts'
import { isSentinelPatch } from '../recipe/patch.ts'
import {
  PACKAGE_METADATA_FIELDS,
  packageMetadataEqual,
  packageMetadataOfPayload,
  payloadOfPackumentVersion,
  type PackageMetadataPayload,
} from '../registry/payload.ts'
import type { PackumentVersion } from '../registry/types.ts'
import { enrichFieldFilled } from './diagnostics.ts'

export interface HydrateMetadataResult {
  readonly graph: Graph
  readonly observations: PackageManifestEvidence
  readonly hydrated: readonly TarballKey[]
  readonly diagnostics: readonly Diagnostic[]
}

const cmpStr = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function inputsOf(node: Node): TarballKeyInputs {
  return {
    name: node.name,
    version: node.version,
    ...(node.patch === undefined ? {} : { patch: node.patch }),
    ...(node.source === undefined ? {} : { source: node.source }),
  }
}

function representedSubjects(graph: Graph): ReadonlyMap<TarballKey, readonly Node[]> {
  const subjects = new Map<TarballKey, Node[]>()
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const key = stripPeerContextFromNodeId(node.id)
    const variants = subjects.get(key) ?? []
    variants.push(node)
    subjects.set(key, variants)
  }
  return subjects
}

function observedEvidence(
  authority: PackageManifestEvidence,
  subjects: ReadonlyMap<TarballKey, readonly Node[]>,
): PackageManifestEvidence {
  const manifests: Record<TarballKey, PackumentVersion> = Object.create(null) as Record<TarballKey, PackumentVersion>
  for (const key of Object.keys(authority.manifests).sort(cmpStr)) {
    if (subjects.has(key)) manifests[key] = authority.manifests[key]!
  }
  return Object.freeze({
    kind: authority.kind,
    authority: authority.authority,
    manifests: Object.freeze(manifests),
  })
}

function metadataMismatch(subject: TarballKey, message: string): Diagnostic {
  return packageMetadataDiagnostic(
    'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
    subject,
    message,
  )
}

function sourceUnsupported(subject: TarballKey, message: string): Diagnostic {
  return packageMetadataDiagnostic(
    'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
    subject,
    message,
  )
}

function canonicalOverlay(
  expected: Readonly<PackageMetadataPayload>,
  actual: Readonly<PackageMetadataPayload>,
): Readonly<PackageMetadataPayload> {
  return Object.freeze({ ...expected, ...actual })
}

function sameDiagnostic(left: Diagnostic, right: Diagnostic): boolean {
  return left.code === right.code
    && left.subject === right.subject
    && left.severity === right.severity
    && left.message === right.message
    && JSON.stringify(left.data) === JSON.stringify(right.data)
}

export function hydrateMetadata(
  graph: Graph,
  input: PackageManifestEvidence,
): HydrateMetadataResult {
  const authority = normalizePackageManifestEvidence(input)
  const subjects = representedSubjects(graph)
  const observations = observedEvidence(authority, subjects)
  const hydrated: TarballKey[] = []
  const diagnostics: Diagnostic[] = []
  let next = graph

  const apply = (
    inputs: TarballKeyInputs,
    payload: TarballPayload | undefined,
    emitted: readonly Diagnostic[],
  ): void => {
    const fresh = emitted.filter(diagnostic =>
      !next.diagnostics().some(existing => sameDiagnostic(existing, diagnostic)))
    if (payload === undefined && fresh.length === 0) return
    next = next.mutate(mutator => {
      if (payload !== undefined) mutator.setTarball(inputs, payload)
      for (const diagnostic of fresh) mutator.diagnostic(diagnostic)
    }).graph
    diagnostics.push(...fresh)
  }

  for (const key of Object.keys(observations.manifests).sort(cmpStr)) {
    const variants = subjects.get(key)!
    const representative = variants[0]!
    const manifest = observations.manifests[key]!
    const inputs = inputsOf(representative)
    const payload = graph.tarballOf(representative.id)

    if (variants.some(node => node.name !== manifest.name
      || node.version !== manifest.version
      || toTarballKey(inputsOf(node)) !== key)) {
      apply(inputs, undefined, [metadataMismatch(
        key,
        'package manifest identity does not match the graph subject',
      )])
      continue
    }

    const resolutionType = payload?.resolution?.type
    if (variants.some(node => node.source !== undefined)
      || (resolutionType !== undefined && resolutionType !== 'tarball')) {
      apply(inputs, undefined, [sourceUnsupported(
        key,
        'non-registry package metadata requires explicit source-specific manifest evidence',
      )])
      continue
    }

    if (representative.patch !== undefined) {
      if (authority.authority !== 'tarball-manifest') {
        apply(inputs, undefined, [sourceUnsupported(
          key,
          'patched package metadata requires exact tarball-manifest evidence',
        )])
        continue
      }
      if (isSentinelPatch(representative.patch)) {
        apply(inputs, undefined, [sourceUnsupported(
          key,
          'sentinel-patched package metadata cannot be hydrated',
        )])
        continue
      }
    }

    const actual = packageMetadataOfPayload(payload)
    const expected = packageMetadataOfPayload(payloadOfPackumentVersion(manifest))
    if (!packageMetadataEqual(canonicalOverlay(expected, actual), expected)) {
      apply(inputs, undefined, [metadataMismatch(
        key,
        'canonical package metadata does not match authoritative manifest evidence',
      )])
      continue
    }

    const fields = PACKAGE_METADATA_FIELDS.filter(field =>
      actual[field] === undefined && expected[field] !== undefined)
    if (fields.length === 0) continue

    const nextPayload: TarballPayload = { ...payload }
    for (const field of fields) Object.assign(nextPayload, { [field]: expected[field] })
    const emitted = fields.map(field => Object.freeze(enrichFieldFilled(
      key,
      field,
      `package-manifest:${authority.authority}`,
    )))
    apply(inputs, nextPayload, emitted)
    hydrated.push(key)
  }

  return Object.freeze({
    graph: next,
    observations,
    hydrated: Object.freeze(hydrated),
    diagnostics: Object.freeze(diagnostics),
  })
}
