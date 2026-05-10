import { isDeepStrictEqual } from 'node:util'
import type { Diagnostic, Graph } from '../../main/ts/graph.ts'
import { parse as parseSyml, type SymlMap } from '../../main/ts/formats/_yarn-syml.ts'
import { featurePresence, graphSubset } from './_graph-features.ts'
import type { AdditionEntry, ConversionContract, LossEntry, PassthroughEntry } from './_matrix.ts'

export type ObservationContext = {
  sourceGraph: Graph
  destinationGraph: Graph
  sourceLockfile?: string
  destinationLockfile?: string
  mode: 'naive' | 'enrich-aware'
  manifestsProvided?: boolean
}

// activeContract and observeInteropDiagnostics share the same per-entry observation
// predicates; F10 collapses the two passes by having both consumers iterate the
// matrix once with the same predicate dispatch.

export function activeContract(
  contract: ConversionContract,
  context: ObservationContext,
): ConversionContract {
  return {
    ...contract,
    lost: contract.lost.filter(entry => lossObserved(entry, context)),
    added: contract.added.filter(entry =>
      entry.diagnostic !== undefined
      && entry.severity !== undefined
      && additionObserved(entry, context),
    ),
    passthrough: contract.passthrough.filter(entry => passthroughObserved(entry, context)),
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

function lossObserved(entry: LossEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return featurePresence(context.sourceGraph, 'conditions')
        && !graphSubset(context.sourceGraph, context.destinationGraph, ['conditions'])
    case 'peer-virt':
      return featurePresence(context.sourceGraph, 'peer-virt')
        && !graphSubset(context.sourceGraph, context.destinationGraph, ['peer-virt'])
    case 'patch':
      return featurePresence(context.sourceGraph, 'patch')
        && !featurePresence(context.destinationGraph, 'patch')
    case 'virtual':
      return featurePresence(context.sourceGraph, 'virtual')
        && !featurePresence(context.destinationGraph, 'virtual')
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
      // No-op additions: matrix records that the destination format *can* carry
      // these fields but the current conversion path leaves them absent. Filtered
      // out upstream via `entry.diagnostic === undefined`; switch arm exists to
      // satisfy exhaustiveness over `AdditionField`.
      return false
    default:
      return assertExhaustive(entry.field, 'additionObserved')
  }
}

function passthroughObserved(entry: PassthroughEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return featurePresence(context.sourceGraph, 'conditions')
        && graphSubset(context.sourceGraph, context.destinationGraph, ['conditions'])
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
