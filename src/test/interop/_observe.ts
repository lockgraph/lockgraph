import { isDeepStrictEqual } from 'node:util'
import type { Diagnostic, Graph, TarballPayload } from '../../main/ts/graph.ts'
import { parse as parseSyml, type SymlMap } from '../../main/ts/formats/_yarn-syml.ts'
import { featurePresence } from './_graph-features.ts'
import type { AdditionEntry, ConversionContract, LossEntry, PassthroughEntry } from './_matrix.ts'

export type ObservationContext = {
  sourceGraph: Graph
  destinationGraph: Graph
  sourceLockfile?: string
  destinationLockfile?: string
  mode: 'naive' | 'enrich-aware'
  manifestsProvided?: boolean
}

// `activeContract` and `observeInteropDiagnostics` deliberately use *different*
// predicates: `applies` is source-side only (does the fixture activate this
// contract entry?), `observed` looks at both source and destination (did the
// adapter actually exhibit the declared behaviour?). When the two diverge —
// e.g. matrix declares peer-virt loss for the fixture but the adapter forgot
// to drop peer-virt — `assertConversionContract` reports "missing declared
// diagnostic", surfacing the adapter bug instead of fabricating consistency.

export function activeContract(
  contract: ConversionContract,
  context: ObservationContext,
): ConversionContract {
  return {
    ...contract,
    lost: contract.lost.filter(entry => lossApplies(entry, context)),
    added: contract.added.filter(entry =>
      entry.diagnostic !== undefined
      && entry.severity !== undefined
      && additionApplies(entry, context),
    ),
    passthrough: contract.passthrough.filter(entry => passthroughApplies(entry, context)),
  }
}

export function observeInteropDiagnostics(
  contract: ConversionContract,
  context: ObservationContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  for (const entry of contract.lost) {
    if (lossObserved(entry, context)) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.feature))
    }
  }

  for (const entry of contract.added) {
    if (
      entry.diagnostic !== undefined
      && entry.severity !== undefined
      && additionObserved(entry, context)
    ) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.field))
    }
  }

  for (const entry of contract.passthrough) {
    if (passthroughObserved(entry, context)) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.feature))
    }
  }

  return diagnostics
}

function toDiagnostic(
  code: string,
  severity: 'warning' | 'info',
  contract: ConversionContract,
  subject: string,
): Diagnostic {
  return {
    code,
    severity,
    message: `${contract.from} -> ${contract.to}: ${subject}`,
  }
}

// applies: source-side state — does this contract entry activate for the
// current fixture? Used by `activeContract` to narrow expectations.

function lossApplies(entry: LossEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
    case 'peer-virt':
    case 'patch':
    case 'virtual':
    case 'workspace-metadata':
      return featurePresence(context.sourceGraph, entry.feature)
    case 'cacheKey':
      return hasBerryMetadataField(context.sourceLockfile, 'cacheKey')
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
    case 'sentinel-collapsed':
      return featurePresence(context.sourceGraph, 'sentinel-collapsed')
    case 'multi-spec-collapsed':
      return featurePresence(context.sourceGraph, 'multi-spec-collapsed')
        || hasClassicMultiSpecEntry(context.sourceLockfile)
    // Graph-shape losses (npm-{2,3} → npm-1 partition). Whether the loss fires
    // is fixture-dependent — `simple` round-trips cleanly, `peers-basic` drops
    // peer edges + tarball extras. `applies` ≡ `observed` so the contract
    // narrows to exactly the fixtures that exhibit the divergence.
    case 'edges':
      return edgeMissingByDst(context.sourceGraph, context.destinationGraph)
    case 'edge-kinds':
      return edgeKindMissing(context.sourceGraph, context.destinationGraph)
    case 'tarballs':
      return tarballPayloadDiverged(context.sourceGraph, context.destinationGraph)
    // 'workspace' is stricter than 'workspace-metadata': requires actual
    // members (non-empty `workspacePath`) or workspace-edge attrs, not the
    // bookkeeping `workspacePath: ''` that npm parsers always set on root.
    case 'workspace':
      return hasWorkspaceMembers(context.sourceGraph)
        && !workspaceMembersPreserved(context.sourceGraph, context.destinationGraph)
    // ADR-0020 Phase C-i: distinct from `workspace` (full primitive drop,
    // npm-1 case). `workspace-rekey` fires when both PMs CAN encode the
    // workspace shape but disagree on the identity convention — yarn-berry's
    // `<name>@0.0.0-use.local` vs pnpm-v9's path-keyed `<path>@<version>`.
    // `applies ≡ observed` (graph-shape loss, ADR-0020 §2 honesty principle):
    // captured by source workspace nodes (workspacePath !== undefined,
    // includes empty-string root marker) missing by id in destination.
    case 'workspace-rekey':
      return hasWorkspaceRekey(context.sourceGraph, context.destinationGraph)
    // ADR-0020 Phase C-iii (yb9 -> npm-3): canonical resolution type degrades
    // from `tarball` (with registry URL) to `unknown` (with raw locator) when
    // the destination format cannot translate the source-PM-native locator
    // (yarn-berry's `<name>@npm:<version>`) into a registry URL. Per-node
    // tarball.resolution.type mismatch on at least one node. `applies ≡
    // observed` (graph-shape loss, ADR-0020 §2 honesty principle).
    case 'resolved-url':
      return resolvedUrlDegrades(context.sourceGraph, context.destinationGraph)
    default:
      return assertExhaustive(entry.feature, 'lossApplies')
  }
}

function additionApplies(entry: AdditionEntry, context: ObservationContext): boolean {
  switch (entry.field) {
    case '__metadata.version':
      // Synthesis condition: source isn't already berry. Destination state
      // is checked in `additionObserved`.
      return !looksLikeBerry(context.sourceLockfile)
    case 'workspace metadata':
      return context.mode === 'enrich-aware' && context.manifestsProvided === true
    case 'conditions default':
    case 'compressionLevel default':
      // No-op additions: filtered out upstream via `entry.diagnostic === undefined`.
      return false
    default:
      return assertExhaustive(entry.field, 'additionApplies')
  }
}

function passthroughApplies(entry: PassthroughEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return featurePresence(context.sourceGraph, 'conditions')
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
    default:
      return assertExhaustive(entry.feature, 'passthroughApplies')
  }
}

// observed: actual source-vs-destination state — did the adapter really
// drop / synthesize / preserve this feature? Used by `observeInteropDiagnostics`
// to emit real diagnostics. Divergence from `applies` is the adapter bug
// signal that adversary B1 demanded.

function lossObserved(entry: LossEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
    case 'peer-virt':
    case 'patch':
    case 'virtual':
      return featurePresence(context.sourceGraph, entry.feature)
        && !featurePresence(context.destinationGraph, entry.feature)
    case 'workspace-metadata':
      return featurePresence(context.sourceGraph, 'workspace-metadata')
        && !workspaceMetadataPreserved(context.sourceGraph, context.destinationGraph)
    case 'cacheKey':
      return hasBerryMetadataField(context.sourceLockfile, 'cacheKey')
        && !hasBerryMetadataField(context.destinationLockfile, 'cacheKey')
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
        && !hasBerryMetadataField(context.destinationLockfile, 'compressionLevel')
    case 'sentinel-collapsed':
      return featurePresence(context.sourceGraph, 'sentinel-collapsed')
        && !featurePresence(context.destinationGraph, 'sentinel-collapsed')
    case 'multi-spec-collapsed':
      return (featurePresence(context.sourceGraph, 'multi-spec-collapsed')
        || hasClassicMultiSpecEntry(context.sourceLockfile))
        && !hasClassicMultiSpecEntry(context.destinationLockfile)
    case 'edges':
      return edgeMissingByDst(context.sourceGraph, context.destinationGraph)
    case 'edge-kinds':
      return edgeKindMissing(context.sourceGraph, context.destinationGraph)
    case 'tarballs':
      return tarballPayloadDiverged(context.sourceGraph, context.destinationGraph)
    case 'workspace':
      return hasWorkspaceMembers(context.sourceGraph)
        && !workspaceMembersPreserved(context.sourceGraph, context.destinationGraph)
    case 'workspace-rekey':
      return hasWorkspaceRekey(context.sourceGraph, context.destinationGraph)
    case 'resolved-url':
      return resolvedUrlDegrades(context.sourceGraph, context.destinationGraph)
    default:
      return assertExhaustive(entry.feature, 'lossObserved')
  }
}

function additionObserved(entry: AdditionEntry, context: ObservationContext): boolean {
  switch (entry.field) {
    case '__metadata.version':
      return !looksLikeBerry(context.sourceLockfile)
        && hasBerryMetadataField(context.destinationLockfile, 'version')
    case 'workspace metadata':
      return context.mode === 'enrich-aware'
        && context.manifestsProvided === true
        && featurePresence(context.destinationGraph, 'workspace-metadata')
    case 'conditions default':
    case 'compressionLevel default':
      return false
    default:
      return assertExhaustive(entry.field, 'additionObserved')
  }
}

function passthroughObserved(entry: PassthroughEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return featurePresence(context.sourceGraph, 'conditions')
        && featurePresence(context.destinationGraph, 'conditions')
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
        && hasBerryMetadataField(context.destinationLockfile, 'compressionLevel')
    default:
      return assertExhaustive(entry.feature, 'passthroughObserved')
  }
}

// Compile-time exhaustiveness gate: typed-union narrowing in the switch arms
// above must reduce `value` to `never` here. Adding a new member to
// `LossFeature` / `AdditionField` / `PassthroughFeature` without a matching
// case raises a TS error. The runtime `Error` is unreachable when the compiler
// is satisfied, kept for defence in depth.
function assertExhaustive(value: never, scope: string): never {
  throw new Error(`${scope}: unreachable contract entry ${String(value)}`)
}

// `edges` loss: kind-agnostic dst presence. Fires when an outgoing edge from
// a source node has no counterpart with the same `dst` in the destination —
// e.g. peer edges drop entirely on npm-1 emit because npm-1 has no peer slot.
function edgeMissingByDst(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    for (const edge of source.out(node.id)) {
      if (!destination.out(edge.src).some(c => c.dst === edge.dst)) return true
    }
  }
  return false
}

// `edge-kinds` loss: non-prod kind (dev/peer/optional) absent in destination
// for the same (src, dst). Prod (`dep`) is the canonical fallback so kind
// collapse manifests as a missing typed counterpart.
function edgeKindMissing(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    for (const edge of source.out(node.id)) {
      if (edge.kind === 'dep') continue
      if (!destination.out(edge.src).some(c => c.dst === edge.dst && c.kind === edge.kind)) return true
    }
  }
  return false
}

// `tarballs` loss: any source tarball payload not deep-equal to its destination
// counterpart (modulo `resolution`, per ADR-0014 §4.F3 attribution divergence).
function tarballPayloadDiverged(source: Graph, destination: Graph): boolean {
  const destTarballs = new Map(Array.from(destination.tarballs()))
  for (const [key, payload] of source.tarballs()) {
    if (!isDeepStrictEqual(stripResolution(destTarballs.get(key)), stripResolution(payload))) return true
  }
  return false
}

// Strict workspace-presence check: members (non-empty workspacePath) OR
// workspace-flagged edges. Excludes the npm parser bookkeeping convention of
// stamping `workspacePath: ''` on the root regardless of workspace setup.
function hasWorkspaceMembers(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined && node.workspacePath !== '') return true
  }
  for (const node of graph.nodes()) {
    if (graph.out(node.id).some(edge => edge.attrs?.workspace === true)) return true
  }
  return false
}

function workspaceMembersPreserved(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    if (node.workspacePath === undefined || node.workspacePath === '') continue
    if (destination.getNode(node.id)?.workspacePath !== node.workspacePath) return false
  }
  return true
}

// `workspace-rekey`: at least one source workspace node (workspacePath defined,
// includes the empty-string root marker) is not present by id in destination.
// Captures cross-family identity-convention mismatch — yarn-berry vs pnpm-v9
// disagree on how to spell root and workspace-member NodeIds, so the comparator
// reports `nodes` / `edges` / `edge-kinds` / `resolved-url` /
// `workspace-membership` all dropping even though the workspace graph is
// semantically the same.
function hasWorkspaceRekey(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    if (node.workspacePath === undefined) continue
    if (destination.getNode(node.id) === undefined) return true
  }
  return false
}

// `resolved-url`: source has a canonically-typed tarball resolution
// (`tarball` / `git` / `directory`, ADR-0014 §4.F3) that degrades to
// `unknown` (or vanishes) in destination because the cross-family stringifier
// emits the PM-native locator verbatim into a `resolved:` field the
// destination parser cannot recognise as a registry URL. Mirror nodes by id;
// non-aligned ids fall under the workspace-rekey / multi-spec arms.
function resolvedUrlDegrades(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    const srcCanonical = source.tarballOf(node.id)?.resolution
    if (srcCanonical === undefined || srcCanonical.type === 'unknown') continue
    if (destination.getNode(node.id) === undefined) continue
    const dstCanonical = destination.tarballOf(node.id)?.resolution
    if (dstCanonical === undefined) return true
    if (dstCanonical.type !== srcCanonical.type) return true
  }
  return false
}

function stripResolution(payload: TarballPayload | undefined): TarballPayload | undefined {
  if (payload === undefined) return undefined
  if (payload.resolution === undefined) return payload
  const { resolution: _resolution, ...rest } = payload
  return rest
}

function workspaceMetadataPreserved(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    if (node.workspacePath !== undefined && destination.getNode(node.id)?.workspacePath !== node.workspacePath) {
      return false
    }
  }

  for (const node of source.nodes()) {
    for (const edge of source.out(node.id)) {
      if (edge.attrs?.workspace !== true) continue
      const found = destination.out(edge.src).some(candidate =>
        candidate.dst === edge.dst
          && candidate.kind === edge.kind
          && candidate.attrs?.workspace === true
          && isDeepStrictEqual(candidate.attrs?.range, edge.attrs?.range),
      )
      if (!found) return false
    }
  }

  return true
}

function looksLikeBerry(lockfile: string | undefined): boolean {
  return lockfile?.includes('__metadata:') === true
}

function hasBerryMetadataField(lockfile: string | undefined, field: string): boolean {
  const meta = berryMetadata(lockfile)
  return meta !== undefined && Object.prototype.hasOwnProperty.call(meta, field)
}

// Classic multi-spec entry keys carry comma-joined specs ("foo@^1, foo@^2"),
// always quoted (mustQuoteEntryKey forces quoting for multi-spec). Berry emits
// multi-spec keys in the same shape ("foo@npm:^1, foo@npm:^2"), so the regex
// here matches both — `multi-spec-collapsed` only fires when destination text
// no longer contains a multi-spec key.
const CLASSIC_MULTI_SPEC_ENTRY_RE = /^"[^"\n]+,[^"\n]+":/m
function hasClassicMultiSpecEntry(lockfile: string | undefined): boolean {
  return lockfile !== undefined && CLASSIC_MULTI_SPEC_ENTRY_RE.test(lockfile)
}

function berryMetadata(lockfile: string | undefined): SymlMap | undefined {
  if (lockfile === undefined || !looksLikeBerry(lockfile)) return undefined
  const parsed = parseSyml(lockfile)
  const meta = parsed['__metadata']
  return meta !== undefined && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as SymlMap
    : undefined
}
