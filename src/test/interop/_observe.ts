import { isDeepStrictEqual } from 'node:util'
import type { Diagnostic, Graph } from '../../main/ts/graph.ts'
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

function berryMetadata(lockfile: string | undefined): SymlMap | undefined {
  if (lockfile === undefined || !looksLikeBerry(lockfile)) return undefined
  const parsed = parseSyml(lockfile)
  const meta = parsed['__metadata']
  return meta !== undefined && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as SymlMap
    : undefined
}
