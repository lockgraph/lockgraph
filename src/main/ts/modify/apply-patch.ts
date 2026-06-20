// ADR-0023 §3.2 — `applyPatch`.
//
// Wire `Node.patch` for every node matching a spec; canonical bytes via
// ADR-0014 §4.F5 normalisation. Sentinel-keyed source nodes are refused
// at the modifier floor (B1 / F5): the modifier detects the sentinel
// BEFORE invoking the Mutator and emits MODIFY_SENTINEL_REFUSED.
//
// ADR-0023 §7.4 / §9.2: when F5 normalisation rewrites ≥ 1 byte of the
// patch input, fire RECIPE_PATCH_NORMALISED (info, recipe-layer code)
// once per applyPatch call. Both that and MODIFY_PATCH_APPLIED land on
// Graph.diagnostics() via Mutator.diagnostic (§8.6 emission path).

import semver from 'semver'
import {
  serializeNodeId,
  type Diagnostic,
  type Graph,
  type Node,
  type NodeId,
  type TarballPayload,
} from '../graph.ts'
import { hashAndNormaliseBytes, isSentinelPatch } from '../recipe/patch.ts'
import { patchNormalisedDiagnostic } from '../recipe/diagnostics.ts'
import type { ModifyContext } from './context.ts'
import {
  modifyPatchApplied,
  modifySentinelRefused,
} from './diagnostics.ts'

export interface ApplyPatchSpec {
  name:    string
  /** Optional semver range; defaults to '*' (every version with this name). */
  range?:  string
}

export interface ApplyPatchResult {
  graph:            Graph
  patched:          Array<{ from: NodeId; to: NodeId }>
  recentlyAdded:    Set<NodeId>
  recentlyOrphaned: Set<NodeId>
  unresolved:       Diagnostic[]
}

/**
 * Apply patch bytes to every node matching `spec`. Returns a graph where
 * each matched node has been re-keyed with the `+patch=<sha512-hex>` slot.
 *
 * Sentinel-keyed source nodes are refused per ADR-0023 §3.3 / B1 — the
 * Mutator would throw LockfileError({code:'IRREDUCIBLE_LOSS'}) on
 * setTarball, so we pre-detect and emit MODIFY_SENTINEL_REFUSED.
 *
 * Bytes are F5-normalised before the F2 sha512 fingerprint runs.
 */
export async function applyPatch(
  graph: Graph,
  spec: ApplyPatchSpec,
  patchBytes: Uint8Array | string,
  _context: ModifyContext,
  options: { onDiagnostic?: (d: Diagnostic) => void } = {},
): Promise<ApplyPatchResult> {
  const onDiagnostic = options.onDiagnostic
  const unresolved: Diagnostic[] = []
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  // F5 normalisation + F2 sha512 fingerprint in one linear pass.
  const { hash, normalised } = hashAndNormaliseBytes(patchBytes)
  const range = spec.range ?? '*'

  // Enumerate matched nodes — work on a snapshot copy to avoid index issues
  // as the graph mutates underneath.
  const matched: Node[] = []
  for (const id of graph.byName(spec.name)) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    if (!matchesRange(node.version, range)) continue
    matched.push(node)
  }

  const patched: Array<{ from: NodeId; to: NodeId }> = []
  const recentlyAdded:    Set<NodeId> = new Set()
  const recentlyOrphaned: Set<NodeId> = new Set()

  let currentGraph = graph

  for (const node of matched) {
    // B1 / F5: sentinel-keyed source refusal BEFORE Mutator dispatch.
    if (node.patch !== undefined && isSentinelPatch(node.patch)) {
      const d = modifySentinelRefused(node.id, 'applyPatch')
      emit(d)
      currentGraph = currentGraph.mutate(m => { m.diagnostic(d) }).graph
      continue
    }

    // Compute new NodeId with patch slot. Per ADR-0011 the patch slot is on the
    // tarball-key, not the peer-context bracket — serializeNodeId handles both.
    const newId = serializeNodeId(node.name, node.version, node.peerContext, hash)
    if (newId === node.id) {
      // No-op — node already carries this exact patch hash.
      continue
    }

    // The existing tarball payload (if any) carries cross-format metadata
    // we want to preserve on the new key. Fetch by old key first.
    const oldPayload = currentGraph.tarballOf(node.id)

    const newNode: Node = {
      ...node,
      id:    newId,
      patch: hash,
    }

    const appliedDiag = modifyPatchApplied(newId)
    const replaceResult = currentGraph.mutate(m => {
      m.replaceNode(node.id, newNode)
      m.diagnostic(appliedDiag)
    })
    currentGraph = replaceResult.graph

    // Set tarball under the new key. The payload may have been undefined
    // (no tarball facts known); we still call setTarball so the new key
    // is registered (with whatever facts we have, including potentially
    // none — empty payload is admissible per the type).
    const payload: TarballPayload = oldPayload ?? {}
    const tarballResult = currentGraph.mutate(m => {
      m.setTarball({ name: node.name, version: node.version, patch: hash }, payload)
    })
    currentGraph = tarballResult.graph

    // newId !== node.id here — the equal case already `continue`d above.
    patched.push({ from: node.id, to: newId })
    recentlyAdded.add(newId)
    recentlyOrphaned.add(node.id)
    emit(appliedDiag)
  }

  // ADR-0023 §7.4 / §9.2: RECIPE_PATCH_NORMALISED fires once per applyPatch
  // invocation when F5 normalisation altered ≥ 1 byte (CRLF→LF / BOM strip).
  // LF-only input passes through unchanged — no emit. The byte event is
  // call-level, but we subject it to the first patched NodeId so adapters
  // that key by NodeId (recipe convention) get a concrete locus; with no
  // patched node there is no useful locus, so skip.
  if (normalised && patched.length > 0) {
    const subject = patched[0]!.to
    const d = patchNormalisedDiagnostic(subject)
    emit(d)
    currentGraph = currentGraph.mutate(m => { m.diagnostic(d) }).graph
  }

  return {
    graph: currentGraph,
    patched,
    recentlyAdded,
    recentlyOrphaned,
    unresolved,
  }
}

function matchesRange(version: string, range: string): boolean {
  if (range === '*') return true
  try {
    return semver.satisfies(version, range)
  } catch {
    return false
  }
}
