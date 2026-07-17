import { createHash } from 'node:crypto'
import path from 'node:path'
import semver from 'semver'
import {
  newBuilder,
  GraphError,
  type Graph,
  type Mutator,
  type MutateResult,
  type Node,
  type NodeId,
  type ChangeRecord,
  type EdgeAttrs,
  type EdgeKind,
  nameOf,
  serializeNodeId,
  stripPeerContextFromNodeId,
  type TarballPayload,
  toTarballKey,
  type Diagnostic,
  type OverrideConstraint,
} from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { readWorkspaceFileBytes } from './_path.ts'
import {
  parse as parseSyml,
  stringify as stringifySyml,
  type SymlMap,
  type SymlValue,
} from './_yarn-syml.ts'
import {
  parseBerryChecksum,
  emitBerryChecksum,
  isEmptyIntegrity,
} from '../recipe/integrity.ts'
import {
  parse as parseResolutionRecipe,
  sourceDiscriminatorOf,
  stringifyForYarnBerry,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  hashAndNormaliseBytes as patchHashAndNormaliseBytes,
  sentinelHashOfLocator,
} from '../recipe/patch.ts'
import { ambiguousResolutionDiagnostic, emitDropped, emitIntegrityIncomplete, patchNormalisedDiagnostic, patchPreferredDiagnostic, recipePeerMetaIncomplete, resolutionPinUnresolvedDiagnostic, unknownResolutionDiagnostic } from '../recipe/diagnostics.ts'
import { catalogResolve, distTagResolve, overrideTargetFor, patchPreferenceFor, semverResolve, type PatchSibling, type SemverCandidate } from '../recipe/descriptor-resolve.ts'
import { readInstalledManifest, type InstalledManifestMeta } from '../complete/local-manifest.ts'

// Yarn-berry entry-spec grammar requires `<scheme>:` on every spec
// (`parseSpec` throws PARSE_FAILED otherwise). Cross-family inputs
// (pnpm-v9 bare semver ranges) lack the scheme — synthesise `npm:` so
// reparse stays well-formed. Per ADR-0016 §B `npm:` is the default
// protocol for registry packages.
const PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+\-.]*:/

// #119 NIT A — a GitHub-shorthand range (`owner/repo`, `owner/repo#ref`) is NOT
// a bare npm range: yarn writes it VERBATIM in both the entry key and the
// dependency-block value (`pem: dexus/pem`, `buffer: "mischnic/buffer#…"`),
// resolving it via the `git`/`github` plugin — it must NEVER be defaulted to
// `npm:`. This is the no-protocol branch of yarn's `gitUtils.gitPatterns`
// shorthand recogniser, transcribed verbatim from
// `yarnpkg/berry/packages/plugin-git/sources/gitUtils.ts`:
//   /^(?:github:|https:\/\/github\.com\/)?(?!\.{1,2}\/)([a-zA-Z._0-9-]+)\/
//    (?!\.{1,2}(?:#|$))([a-zA-Z._0-9-]+?)(?:\.git)?(?:#.*)?$/
// reduced to the bare form (the optional `github:`/URL prefix is already caught
// by `PROTOCOL_RE` / `hasExplicitProtocol`, so only the prefix-less `owner/repo`
// shape reaches here). The `(?!\.{1,2}\/)` / `(?!\.{1,2}(?:#|$))` look-aheads
// reject `./`-`../` relative paths; the `[a-zA-Z._0-9-]+` segments forbid `:`
// and whitespace, so a semver range (`5.0.x || 5.1.x`, `>=4.8.4 <6.1.0`) — which
// never contains `/` — and any protocol-bearing or path range can never match.
// Validated against the whole real-world berry corpus: the ONLY two prefix-less
// dependency ranges containing `/` are exactly `dexus/pem` and
// `mischnic/buffer#b8a4fa94`, both genuine GitHub shorthands.
const GITHUB_SHORTHAND_RE =
  /^(?!\.{1,2}\/)[a-zA-Z._0-9-]+\/(?!\.{1,2}(?:#|$))[a-zA-Z._0-9-]+?(?:\.git)?(?:#.*)?$/

// Does `range` need the synthesised `npm:` default protocol? No for an explicit
// `<scheme>:` (already well-formed) and no for a GitHub shorthand (yarn keeps it
// verbatim — #119 NIT A); yes for a prefix-less semver range.
function entryKeyRangeOf(range: string): string {
  return PROTOCOL_RE.test(range) || GITHUB_SHORTHAND_RE.test(range) ? range : `npm:${range}`
}

function looksLikePatchLocator(raw: string | undefined): boolean {
  return raw !== undefined && raw.includes('@patch:')
}

// Yarn-berry workspace `link:` and `portal:` resolutions point to a local
// filesystem directory; the optional `::locator=<encoded-workspace-locator>`
// qualifier disambiguates which workspace consumer "owns" the reference.
// Two entries with identical name+version but different `::locator=...`
// qualifiers are legitimately distinct (same physical directory referenced
// from different consumers in any multi-workspace
// monorepo). Without disambiguation they collapse onto one NodeId and
// trip IRREDUCIBLE_LOSS. We treat the locator+qualifier as a sentinel-
// patch discriminator: the patch slot is the only NodeId-affecting carrier
// in the ADR-0006/0011 schema, and the sentinel grammar
// (`unresolved-<sha256>`) accepts arbitrary discriminators while keeping
// validatePatchToken intact. The Node.resolution carries the verbatim
// locator string for lossless round-trip.
function isLinkOrPortalResolution(resolution: string, name: string): boolean {
  return resolution.startsWith(`${name}@link:`) || resolution.startsWith(`${name}@portal:`)
}

// A `file:` resolution is ALWAYS a local artefact (local-tarball alias or a
// directory link) — never a registry package (those use `npm:`). When yarn
// records a `locator=<encoded-consumer-locator>` qualifier in its `::`-param
// block, that qualifier names which workspace consumer owns the reference,
// exactly as for `link:`/`portal:`. Such an entry can collide on NodeId with a
// sibling registry entry at the SAME name@version yet be a genuinely different
// artefact (Bug #76: resolution
// `@k8ts/sample-interfaces@file:.lib/….tgz#….tgz::hash=17d4d9&locator=…`
// — canonical `tarball`, its own checksum + dep ranges — vs the sibling
// `@k8ts/sample-interfaces@npm:0.6.3` — registry). They must stay DISTINCT
// nodes, so the `file:` alias takes the same sentinel-patch disambiguator.
// Gate on the `locator=` qualifier (NB: in the *resolution* it rides the `::`
// param block as `::hash=…&locator=…`, whereas the *entry key* writes a bare
// `::locator=…`) so a plain `file:../dir` directory link with no consumer
// qualifier — already a unique node — is left unpatched; only the consumer-
// owned alias that can actually collide is discriminated.
function isFileLocatorResolution(resolution: string, name: string): boolean {
  if (!resolution.startsWith(`${name}@file:`)) return false
  const paramsIdx = resolution.indexOf('::')
  return paramsIdx >= 0 && /(^|&)locator=/.test(resolution.slice(paramsIdx + 2))
}

// Local-artefact locators whose `::locator=` (or link/portal protocol) carries
// a consumer-ownership discriminator that the NodeId must preserve. Drives both
// the parse-side sentinel-patch assignment and the emit-side verbatim
// round-trip so the two stay in lockstep.
function isLocalLocatorDisambiguatedResolution(resolution: string, name: string): boolean {
  return isLinkOrPortalResolution(resolution, name) || isFileLocatorResolution(resolution, name)
}

const PREAMBLE =
  '# This file is generated by running "yarn install" inside your project.\n' +
  '# Manual changes might be lost - proceed with caution!'
const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const EMPTY_SIDECAR: YarnBerryFamilySidecar = {}

export interface YarnBerryFamilyParseOptions {
  workspaceRoot?: string
  // Bug #99 — canonical override constraints (ADR-0025), threaded from the public
  // `parse()` after F6-capturing `ParseOptions.manifests`. yarn writes NO
  // lock-borne resolutions, so a `resolutions` pin that rewrote an entry key to a
  // possibly-NON-satisfying descriptor (csstype `^3.1.3` → `3.0.9`) can only be
  // bridged back to its node via this map. Absent → the edge ladder runs Rung-3
  // semver only (the satisfying slice resolves; a non-satisfying pin stays
  // dropped, with an INFO diagnostic noting the missing `manifests`).
  overrides?: OverrideConstraint[]
}

export interface YarnBerryFamilyStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  cacheKey?: string
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface YarnBerryFamilyEnrichOptions {
  // Rung-2 fill source for peer-optional reconstruction (task #86). When set,
  // the enrich pass consults `<workspaceRoot>/node_modules/<parent>/
  // package.json` to recover `peerDependenciesMeta[peer].optional` that a
  // non-yarn source PM (npm / bun / yarn-classic) dropped on parse. Stays
  // offline + sync + deterministic; absent → rung-1 (graph) only.
  workspaceRoot?: string
  // Opt-in rung-3/4 hook (cache / registry). The DEFAULT path never opens a
  // socket — a caller that wants registry-backed peer-optional facts supplies
  // a SYNCHRONOUS resolver here (e.g. closing over a pre-fetched packument or
  // cache snapshot). Returns the parent's declared `peerDependenciesMeta[peer]
  // .optional`, or `undefined` when the resolver cannot answer. This keeps
  // `enrich` synchronous and the convert contract offline-by-default
  // (Anton's Option-1 posture); no async network entry ships in this scope.
  peerMetaResolver?: (parentName: string, parentVersion: string, peerName: string) => boolean | undefined
}
export type YarnBerryFamilyOptimizeOptions = {}

export interface YarnBerryFamilyConfig {
  lockfileVersion: number
  codePrefix: string
  rangeEmit: 'bare' | 'quoted-protocol'
  checksumPrefix: boolean
  conditionsAllowed: boolean
}

// F8/#103 — a dependency-block reference whose target package is ABSENT from the
// lock (no `resolution:` entry block; the descriptor→node ladder's Rung 4 cannot
// bind it). It is NOT a canonical graph edge — there is no target node — so it
// must never mint a phantom/placeholder node or pollute NodeId/edge identity or
// cross-PM conversion. This is pure FORMAT-FIDELITY: the verbatim descriptor
// (its emit block, its dep-name, its exact on-disk range string) is captured here
// and re-emitted into the same inner-block on stringify, so a SAME-FORMAT
// round-trip is byte-faithful — exactly the role `Node.resolution` plays as a
// verbatim PM-native sidecar (ADR-0013 / graph.ts §"Cross-format artefact
// metadata" `resolution?: string`). A cross-PM convert (yarn-berry → npm/pnpm/
// bun) does NOT carry these: the carrier lives only in this berry adapter's
// per-graph WeakMap, which no other adapter reads.
interface UnresolvedDepRef {
  // The EMIT inner-block this ref belongs to — keyed by the on-lock block name so
  // re-emit lands in the right block (`dependencies` for a `dep`-kind drop,
  // `optionalDependencies` for an `optional`-kind drop). Peer refs do NOT use
  // this path — they round-trip via the `peerDependencies` raw sidecar.
  block: 'dependencies' | 'optionalDependencies'
  // The verbatim dependency-block KEY (`ghost`, `@scope/pkg`, an npm-alias key…).
  name: string
  // The verbatim on-disk RANGE string (`npm:^1.0.0`), re-emitted byte-for-byte
  // (NOT the ladder's normalized form) so round-trip matches the source exactly.
  range: string
}

export interface YarnBerryFamilySidecar {
  peerDependencies?: Map<string, Record<string, string>>
  // `conditions:` is a SCALAR token in yarn-berry (e.g. `os=darwin & cpu=arm64`),
  // NOT a structured map — captured verbatim per node so it round-trips byte-
  // faithfully (corrects ADR-0018 §A.v5, which mis-modelled it as a SymlMap).
  conditions?: Map<string, string>
  // `dependenciesMeta:` ({ pkg: { optional|built|… } }) captured as a verbatim
  // per-node block. Round-trip-fidelity only — deep EdgeAttrs modelling for
  // cross-format translation is intentionally out of scope (task #89).
  dependenciesMeta?: Map<string, SymlMap>
  // `peerDependenciesMeta:` ({ peer: { optional: true } }) captured verbatim per
  // node and fed to `peerDependenciesMetaOfNode` as its rung-0 hint, so emit goes
  // through the SAME machinery as the #86 edge-`optional` path (no parallel emit).
  peerDependenciesMeta?: Map<string, SymlMap>
  // F8/#103 — per-node verbatim refs to dep targets ABSENT from the lock (Rung-4
  // drops). Same-format round-trip fidelity only (see `UnresolvedDepRef`); never
  // promoted to graph edges, never carried across a cross-PM convert.
  unresolvedDeps?: Map<string, UnresolvedDepRef[]>
  // B-EXACT — the VERBATIM entry-key descriptor list captured per node at parse
  // (`"<n>@npm:^1.2.3"` → `['<n>@npm:^1.2.3']`; a compound key →
  // `['<n>@npm:@alias@^1', '<n>@npm:^2']`). yarn keys each entry by the
  // descriptor(s) that REFERENCE it (the ranges); the resolved version lives in
  // `version:`/`resolution:` and is NEVER a key descriptor. Reconstructing the key
  // from incoming edges + `node.resolution` synthesizes a spurious exact-version
  // descriptor on EVERY range-only entry (`"<n>@npm:1.2.6, <n>@npm:^1.2.3"`),
  // breaking byte-fidelity and `yarn install --immutable`. Preserving the source
  // descriptor list verbatim re-emits the exact key bytes — and keeps a GENUINE
  // resolutions-pin's exact descriptor (`csstype@npm:3.0.9`) intact, since that is
  // what the source key carried. Same-format round-trip fidelity only: a node the
  // graph REPLACED (new id — a version bump) loses this sidecar and falls back to
  // edge-reconstruction (a fresh, correct key); a cross-PM convert never carries it
  // (the WeakMap is berry-local), so the cross-format key is rebuilt from edges.
  entryKeyDescriptors?: Map<string, string[]>
  metadata?: SymlMap
}

interface SpecPart {
  name: string
  protocol: string
  spec: string
  // The VERBATIM range substring after `<name>@` (`npm:^1`, `dexus/pem`,
  // `workspace:.`, `1.14.1`). Drives the specIndex-key build through the SAME
  // `entryKeyRangeOf` normalisation the edge side uses, so a GitHub-shorthand
  // entry (#119 NIT A) indexes under its verbatim range and the Rung-0 lookup
  // aligns. `protocol`/`spec` stay split for the patch/workspace/name logic.
  raw: string
}

interface DerivedPeer {
  name: string
  range: string
  dstOldId: string
  // Set true when the fill ladder (task #86) determined this peer is optional
  // in the parent's manifest; threaded onto the new peer edge's attrs.
  optional?: boolean
}

interface PendingDiagnostic extends Omit<Diagnostic, 'subject'> {
  subject: string
  candidateIds?: string[]
  peerName?: string
}

const sidecarByGraph = new WeakMap<Graph, YarnBerryFamilySidecar>()

type YarnBerryGraphBuilder = ReturnType<typeof newBuilder>

interface YarnBerryParseEntry {
  readonly key: string
  readonly value: SymlMap
  readonly specs: SpecPart[]
}

interface YarnBerryParseContext {
  readonly ast: SymlMap
  readonly metadata: SymlMap | undefined
  readonly options: YarnBerryFamilyParseOptions
  readonly config: YarnBerryFamilyConfig
  readonly builder: YarnBerryGraphBuilder
  readonly diagnostics: Diagnostic[]
  readonly rawPeerDependencies: Map<string, Record<string, string>>
  readonly rawConditions: Map<string, string>
  readonly rawDependenciesMeta: Map<string, SymlMap>
  readonly rawPeerDependenciesMeta: Map<string, SymlMap>
  readonly rawUnresolvedDeps: Map<string, UnresolvedDepRef[]>
  readonly rawEntryKeyDescriptors: Map<string, string[]>
  readonly entries: YarnBerryParseEntry[]
  readonly specIndex: Map<string, string>
  readonly patchDescriptorIndex: Map<string, PatchDescriptorCandidate[]>
  readonly semverCandidatesByName: Map<string, SemverCandidate[]>
  readonly patchSiblingsByBase: Map<string, PatchSibling[]>
  readonly seenIds: Set<string>
  readonly entryIds: Map<string, string>
}

interface YarnBerryParsedNodeIdentity {
  readonly first: SpecPart
  readonly version: string
  readonly resolution: string | undefined
  readonly authoritativeName: string
  readonly workspaceSpec: string | undefined
  readonly canonicalResolution: ResolutionCanonical | undefined
  readonly effectivePatch: string | undefined
  readonly effectiveSource: string | undefined
  readonly id: string
  readonly patchResult: ReturnType<typeof extractPatchFingerprint>
}

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

export function checkFamily(input: string, config: YarnBerryFamilyConfig): boolean {
  const head = input.slice(0, 4096)
  return new RegExp(
    `^__metadata:\\s*[\\r\\n]+(?:[ \\t]+[^\\n]*[\\r\\n]+)*?[ \\t]+version:\\s*${config.lockfileVersion}\\s*(?:[\\r\\n]|$)`,
    'm',
  ).test(head)
}

function createYarnBerryParseContext(
  input: string,
  options: YarnBerryFamilyParseOptions,
  config: YarnBerryFamilyConfig,
): YarnBerryParseContext {
  const ast = parseSyml(input)
  return {
    ast,
    metadata: validateMetadata(ast, config),
    options,
    config,
    builder: newBuilder(),
    diagnostics: [],
    rawPeerDependencies: new Map<string, Record<string, string>>(),
    rawConditions: new Map<string, string>(),
    rawDependenciesMeta: new Map<string, SymlMap>(),
    rawPeerDependenciesMeta: new Map<string, SymlMap>(),
    rawUnresolvedDeps: new Map<string, UnresolvedDepRef[]>(),
    rawEntryKeyDescriptors: new Map<string, string[]>(),
    entries: [],
    specIndex: new Map<string, string>(),
    patchDescriptorIndex: new Map<string, PatchDescriptorCandidate[]>(),
    semverCandidatesByName: new Map<string, SemverCandidate[]>(),
    patchSiblingsByBase: new Map<string, PatchSibling[]>(),
    seenIds: new Set<string>(),
    entryIds: new Map<string, string>(),
  }
}

/** Validate top-level entry blocks and retain their parsed descriptors. */
function collectYarnBerryParseEntries(context: YarnBerryParseContext): void {
  for (const [key, value] of Object.entries(context.ast)) {
    if (key === '__metadata') continue
    const valueMap = asMap(value)
    if (valueMap === undefined) {
      context.diagnostics.push({
        code: 'YARN_BERRY_BAD_ENTRY',
        severity: 'warning',
        message: `entry ${JSON.stringify(key)} is not a block; skipping`,
      })
      continue
    }
    context.entries.push({ key, value: valueMap, specs: parseEntryKey(key) })
  }
}

/** Derive canonical graph identity before materialising one berry entry. */
function parseYarnBerryNodeIdentity(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
): YarnBerryParsedNodeIdentity {
  const { key, value, specs } = entry
  const first = specs[0]
  if (first === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `entry ${JSON.stringify(key)} has empty spec` })
  }
  const version = asString(value['version'])
  if (version === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `entry ${JSON.stringify(key)} missing 'version'` })
  }

  const resolution = asString(value['resolution'])
  const authoritativeName = resolution === undefined
    ? first.name
    : nameFromResolutionLocator(resolution) ?? first.name
  const baseId = serializeNodeId(authoritativeName, version, [])
  const rawPatchResult = resolution === undefined
    ? undefined
    : extractPatchFingerprint(baseId, resolution, context.options.workspaceRoot)
  const localLocatorPatch = rawPatchResult === undefined
    && resolution !== undefined
    && isLocalLocatorDisambiguatedResolution(resolution, authoritativeName)
    ? sentinelHashOfLocator(resolution)
    : undefined
  const effectivePatch = rawPatchResult?.patch ?? localLocatorPatch
  const workspaceSpec = workspaceSpecOfEntry(resolution, specs, first)
  const canonicalResolution = resolution !== undefined && workspaceSpec === undefined
    ? parseResolutionRecipe(resolution, { sourceKind: 'yarn-berry-locator', name: authoritativeName })
    : undefined
  const effectiveSource = effectivePatch === undefined && canonicalResolution !== undefined
    ? sourceDiscriminatorOf(canonicalResolution)
    : undefined
  const id = serializeNodeId(authoritativeName, version, [], effectivePatch, effectiveSource)
  const patchResult = rawPatchResult?.diagnostic === undefined
    ? rawPatchResult
    : { ...rawPatchResult, diagnostic: { ...rawPatchResult.diagnostic, subject: id } }
  return {
    first,
    version,
    resolution,
    authoritativeName,
    workspaceSpec,
    canonicalResolution,
    effectivePatch,
    effectiveSource,
    id,
    patchResult,
  }
}

/** Add the graph node and exact entry-key identity, rejecting collisions. */
function addYarnBerryGraphNode(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
  identity: YarnBerryParsedNodeIdentity,
): void {
  const { id, authoritativeName, version, effectivePatch, effectiveSource, workspaceSpec } = identity
  if (context.seenIds.has(id)) {
    throw new LockfileError({
      code: 'IRREDUCIBLE_LOSS',
      message: irreducibleCollisionMessage(id, entry.key, context.entries),
    })
  }
  context.seenIds.add(id)
  context.entryIds.set(entry.key, id)
  context.rawEntryKeyDescriptors.set(id, entry.key.split(', '))

  const node: Node = { id, name: authoritativeName, version, peerContext: [] }
  if (effectivePatch !== undefined) node.patch = effectivePatch
  if (effectiveSource !== undefined) node.source = effectiveSource
  if (workspaceSpec !== undefined) node.workspacePath = workspacePathOf(workspaceSpec)
  context.builder.addNode(node)
}

/** Record resolution diagnostics and the descriptor fallback candidate index. */
function indexYarnBerryResolutionCandidate(
  context: YarnBerryParseContext,
  identity: YarnBerryParsedNodeIdentity,
): void {
  const { id, version, authoritativeName, canonicalResolution, resolution, patchResult } = identity
  if (patchResult?.diagnostic !== undefined) context.diagnostics.push(patchResult.diagnostic)
  if (canonicalResolution?.type === 'unknown' && !looksLikePatchLocator(resolution)) {
    context.diagnostics.push(unknownResolutionDiagnostic(id, resolution!))
  }

  const candidate: SemverCandidate = {
    id,
    version,
    sourceType: canonicalResolution?.type ?? 'absent',
  }
  const candidates = context.semverCandidatesByName.get(authoritativeName)
  if (candidates === undefined) context.semverCandidatesByName.set(authoritativeName, [candidate])
  else candidates.push(candidate)
}

/** Index genuine npm-base patch siblings for the descriptor ladder overlay. */
function indexYarnBerryPatchSibling(
  context: YarnBerryParseContext,
  identity: YarnBerryParsedNodeIdentity,
): void {
  const { id, version, authoritativeName, resolution, effectivePatch } = identity
  if (effectivePatch === undefined || resolution === undefined) return
  if (!isNpmBasePatchResolution(resolution, authoritativeName)) return
  const sibling: PatchSibling = { id, locatorQualifier: locatorQualifierOfPatchResolution(resolution) }
  const baseKey = `${authoritativeName}@${version}`
  const siblings = context.patchSiblingsByBase.get(baseKey)
  if (siblings === undefined) context.patchSiblingsByBase.set(baseKey, [sibling])
  else siblings.push(sibling)
}

/** Capture berry-only fields that cannot live on the canonical graph. */
function captureYarnBerryNodeSidecar(
  context: YarnBerryParseContext,
  value: SymlMap,
  id: string,
): void {
  const peerDependencies = stringRecordOfBlock(asMap(value['peerDependencies']))
  if (peerDependencies !== undefined) context.rawPeerDependencies.set(id, peerDependencies)
  const conditions = asString(value['conditions'])
  if (conditions !== undefined) context.rawConditions.set(id, conditions)
  const dependenciesMeta = coerceSymlMap(value['dependenciesMeta'])
  if (dependenciesMeta !== undefined) context.rawDependenciesMeta.set(id, dependenciesMeta)
  const peerDependenciesMeta = coerceSymlMap(value['peerDependenciesMeta'])
  if (peerDependenciesMeta !== undefined) context.rawPeerDependenciesMeta.set(id, peerDependenciesMeta)
}

/** Decode the cache-zip checksum without treating it as tarball integrity. */
function captureYarnBerryChecksum(
  context: YarnBerryParseContext,
  value: SymlMap,
  id: string,
  payload: TarballPayload,
): void {
  const checksum = asString(value['checksum'])
  if (checksum === undefined) return
  const { integrity, cacheKey } = parseBerryChecksum(checksum)
  if (isEmptyIntegrity(integrity)) {
    context.diagnostics.push({
      code: `${context.config.codePrefix}_INVALID_INTEGRITY`,
      severity: 'warning',
      subject: id,
      message: `checksum ${JSON.stringify(checksum)} is not a sha512 berry checksum; dropping integrity`,
    })
    return
  }
  payload.integrity = integrity
  if (cacheKey !== undefined) payload.berryChecksumCacheKey = cacheKey
}

/** Copy the string-valued executable map into the canonical tarball payload. */
function captureYarnBerryBin(value: SymlMap, payload: TarballPayload): void {
  const binMap = asMap(value['bin'])
  if (binMap === undefined) return
  const bin: Record<string, string> = {}
  for (const [name, target] of Object.entries(binMap)) {
    if (typeof target === 'string') bin[name] = target
  }
  if (Object.keys(bin).length > 0) payload.bin = bin
}

/** Materialise canonical artefact facts plus any non-derivable native locator. */
function addYarnBerryTarball(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
  identity: YarnBerryParsedNodeIdentity,
): void {
  const payload: TarballPayload = {}
  captureYarnBerryChecksum(context, entry.value, identity.id, payload)
  captureYarnBerryBin(entry.value, payload)
  if (identity.canonicalResolution !== undefined) payload.resolution = identity.canonicalResolution
  if (
    identity.resolution !== undefined
    && identity.workspaceSpec === undefined
    && identity.resolution !== `${identity.authoritativeName}@npm:${identity.version}`
  ) {
    payload.nativeResolution = identity.resolution
  }
  if (Object.keys(payload).length === 0) return
  context.builder.setTarball({
    name: identity.authoritativeName,
    version: identity.version,
    patch: identity.effectivePatch,
    source: identity.effectiveSource,
  }, payload)
}

/** Index exact entry descriptors, including parameter-stripped patch locators. */
function indexYarnBerryEntrySpecs(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
  id: string,
): void {
  for (const spec of entry.specs) {
    const lookup = `${spec.name}@${entryKeyRangeOf(spec.raw)}`
    if (!context.specIndex.has(lookup)) context.specIndex.set(lookup, id)
    if (spec.protocol !== 'patch') continue
    const stripped = strippedPatchDescriptor(lookup)
    if (stripped === undefined) continue
    const candidates = context.patchDescriptorIndex.get(stripped) ?? []
    candidates.push({ id, locatorQualifier: locatorQualifierOfPatchSpec(spec.spec) })
    context.patchDescriptorIndex.set(stripped, candidates)
  }
}

/** Materialise one berry entry across graph, sidecar, and resolution indexes. */
function addYarnBerryPackageNode(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
): void {
  const identity = parseYarnBerryNodeIdentity(context, entry)
  addYarnBerryGraphNode(context, entry, identity)
  indexYarnBerryResolutionCandidate(context, identity)
  indexYarnBerryPatchSibling(context, identity)
  captureYarnBerryNodeSidecar(context, entry.value, identity.id)
  addYarnBerryTarball(context, entry, identity)
  indexYarnBerryEntrySpecs(context, entry, identity.id)
}

function addYarnBerryPackageNodes(context: YarnBerryParseContext): void {
  for (const entry of context.entries) addYarnBerryPackageNode(context, entry)
}

/** Resolve dependency blocks after all descriptor candidates are indexed. */
function addYarnBerryDependencyEdges(context: YarnBerryParseContext): void {
  const ladder: EdgeLadderContext = {
    candidatesByName: context.semverCandidatesByName,
    patchSiblingsByBase: context.patchSiblingsByBase,
    overrides: context.options.overrides ?? [],
    codePrefix: context.config.codePrefix,
    manifestsProvided: context.options.overrides !== undefined,
  }
  for (const entry of context.entries) {
    if (entry.specs[0] === undefined) continue
    const srcId = context.entryIds.get(entry.key)
    if (srcId === undefined) continue
    addYarnBerryEntryEdges(context, entry, srcId, ladder)
  }
}

function addYarnBerryEntryEdges(
  context: YarnBerryParseContext,
  entry: YarnBerryParseEntry,
  srcId: string,
  ladder: EdgeLadderContext,
): void {
  const srcResolution = asString(entry.value['resolution'])
  const { regular, optional } = splitOptionalDeps(
    asMap(entry.value['dependencies']),
    context.rawDependenciesMeta.get(srcId),
  )
  const add = (block: SymlMap | undefined, kind: EdgeKind): void => addEdgesFromBlock(
    context.builder,
    srcId,
    block,
    kind,
    context.specIndex,
    context.patchDescriptorIndex,
    context.diagnostics,
    ladder,
    srcResolution,
    context.rawUnresolvedDeps,
  )
  add(regular, 'dep')
  add(optional, 'optional')
  add(asMap(entry.value['optionalDependencies']), 'optional')
}

/** Stabilise graph diagnostic order before sealing. */
function addYarnBerryParseDiagnostics(context: YarnBerryParseContext): void {
  context.diagnostics.sort((a, b) => {
    const sa = typeof a.subject === 'string' ? a.subject : ''
    const sb = typeof b.subject === 'string' ? b.subject : ''
    return cmpStr(sa, sb) || cmpStr(a.code, b.code)
  })
  for (const diagnostic of context.diagnostics) context.builder.diagnostic(diagnostic)
}

function createYarnBerrySidecar(context: YarnBerryParseContext): YarnBerryFamilySidecar {
  const sidecar: YarnBerryFamilySidecar = {}
  if (context.rawPeerDependencies.size > 0) sidecar.peerDependencies = context.rawPeerDependencies
  if (context.rawConditions.size > 0) sidecar.conditions = context.rawConditions
  if (context.rawDependenciesMeta.size > 0) sidecar.dependenciesMeta = context.rawDependenciesMeta
  if (context.rawPeerDependenciesMeta.size > 0) sidecar.peerDependenciesMeta = context.rawPeerDependenciesMeta
  if (context.rawUnresolvedDeps.size > 0) sidecar.unresolvedDeps = context.rawUnresolvedDeps
  if (context.rawEntryKeyDescriptors.size > 0) sidecar.entryKeyDescriptors = context.rawEntryKeyDescriptors
  if (context.metadata !== undefined) sidecar.metadata = context.metadata
  return sidecar
}

/** Seal graph invariants, mark workspace edges, and bind adapter state. */
function sealYarnBerryParseContext(
  context: YarnBerryParseContext,
): { graph: Graph; sidecar: YarnBerryFamilySidecar } {
  try {
    const graph = markWorkspaceEdgesAtParse(context.builder.seal())
    const sidecar = createYarnBerrySidecar(context)
    rememberSidecar(graph, sidecar)
    return { graph: withSidecarPropagation(graph, sidecar), sidecar }
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `seal failed: ${error.message}` })
    }
    throw error
  }
}

export function parseFamily(
  input: string,
  options: YarnBerryFamilyParseOptions,
  config: YarnBerryFamilyConfig,
): { graph: Graph; sidecar: YarnBerryFamilySidecar } {
  const context = createYarnBerryParseContext(input, options, config)
  collectYarnBerryParseEntries(context)
  addYarnBerryPackageNodes(context)
  addYarnBerryDependencyEdges(context)
  addYarnBerryParseDiagnostics(context)
  return sealYarnBerryParseContext(context)
}

interface YarnBerryStringifyEntry {
  readonly nodeId: string
  readonly key: string
  readonly value: SymlMap
}

interface YarnBerryStringifyContext {
  readonly graph: Graph
  readonly config: YarnBerryFamilyConfig
  readonly options: YarnBerryFamilyStringifyOptions
  readonly sidecar: YarnBerryFamilySidecar
  readonly diagnostics: Diagnostic[]
  readonly emitDiagnostic: (diagnostic: Diagnostic) => void
  readonly cacheKey: string | undefined
  readonly metadata: SymlMap
  readonly root: SymlMap
}

/** Rebuild frozen-compared metadata while preserving unknown source fields. */
function createYarnBerryStringifyMetadata(
  config: YarnBerryFamilyConfig,
  sidecar: YarnBerryFamilySidecar,
  cacheKey: string | undefined,
): SymlMap {
  const metadata: SymlMap = { version: String(config.lockfileVersion) }
  if (cacheKey !== undefined) metadata['cacheKey'] = cacheKey
  if (sidecar.metadata === undefined) return metadata
  for (const key of Object.keys(sidecar.metadata).sort(cmpStr)) {
    if (key === 'version' || key === 'cacheKey') continue
    const value = cloneSymlValue(sidecar.metadata[key])
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}

function createYarnBerryStringifyContext(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyStringifyOptions,
): YarnBerryStringifyContext {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  const diagnostics: Diagnostic[] = []
  const cacheKey = options.cacheKey ?? asString(sidecar.metadata?.cacheKey)
  const metadata = createYarnBerryStringifyMetadata(config, sidecar, cacheKey)
  return {
    graph,
    config,
    options,
    sidecar,
    diagnostics,
    emitDiagnostic: diagnostic => {
      diagnostics.push(diagnostic)
      options.onDiagnostic?.(diagnostic)
    },
    cacheKey,
    metadata,
    root: { __metadata: metadata },
  }
}

/** Build and sort one native entry per graph node. */
function collectYarnBerryStringifyEntries(
  context: YarnBerryStringifyContext,
): YarnBerryStringifyEntry[] {
  const { graph, config, emitDiagnostic, cacheKey } = context
  return Array.from(graph.nodes(), node => ({
    nodeId: node.id,
    key: entryKeyOfNode(graph, node),
    value: entryOfNode(graph, node, config, emitDiagnostic, cacheKey),
  })).sort((a, b) => cmpStr(a.key, b.key))
}

/** Enforce emit identity uniqueness while populating the syml root. */
function writeYarnBerryStringifyEntries(
  context: YarnBerryStringifyContext,
  entries: readonly YarnBerryStringifyEntry[],
): void {
  const seenIds = new Map<string, string>()
  for (const entry of entries) {
    const node = context.graph.getNode(entry.nodeId)
    const emitId = node === undefined
      ? entry.nodeId
      : toTarballKey({ name: node.name, version: node.version, patch: node.patch, source: node.source })
    const previous = seenIds.get(emitId)
    if (previous !== undefined) {
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `duplicate node id collides on emit: ${emitId} from ${previous}, ${entry.nodeId}`,
      })
    }
    seenIds.set(emitId, entry.nodeId)
    context.root[entry.key] = entry.value
  }
}

/** Serialise syml, restore yarn's bare scalars, then apply line endings. */
function emitYarnBerryStringifyResult(context: YarnBerryStringifyContext): string {
  const { config, options, sidecar, cacheKey, root } = context
  let output = `${PREAMBLE}\n\n${stringifySyml(root)}`
  output = unquoteMetadataScalar(output, 'version', String(config.lockfileVersion))
  if (cacheKey !== undefined && /^-?(0|[1-9][0-9]*)$/.test(cacheKey)) {
    output = unquoteMetadataScalar(output, 'cacheKey', cacheKey)
  }
  const compressionLevel = sidecar.metadata?.compressionLevel
  if (typeof compressionLevel === 'string' && /^-?(0|[1-9][0-9]*)$/.test(compressionLevel)) {
    output = unquoteMetadataScalar(output, 'compressionLevel', compressionLevel)
  }
  output = unquoteConditionsScalars(output)
  output = unquoteMetaBooleanScalars(output)
  return options.lineEnding === 'crlf' ? output.replace(/\n/g, '\r\n') : output
}

export function stringifyFamily(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyStringifyOptions = {},
): { lockfile: string; diagnostics: Diagnostic[] } {
  const context = createYarnBerryStringifyContext(graph, config, options)
  writeYarnBerryStringifyEntries(context, collectYarnBerryStringifyEntries(context))
  return { lockfile: emitYarnBerryStringifyResult(context), diagnostics: context.diagnostics }
}

interface YarnBerryEnrichContext {
  readonly graph: Graph
  readonly config: YarnBerryFamilyConfig
  readonly sidecar: YarnBerryFamilySidecar
  readonly rawPeerDependencies: Map<string, Record<string, string>>
  readonly derivedPeersByNodeId: Map<string, DerivedPeer[]>
  readonly pendingDiagnostics: PendingDiagnostic[]
  readonly peerMeta: PeerMetaContext
  readonly peerOptionalOverrides: Map<string, boolean>
  peerChanged: boolean
  peerMetaChanged: boolean
  derivedPeerOptionalChanged: boolean
}

function createYarnBerryEnrichContext(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyEnrichOptions,
): YarnBerryEnrichContext {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  return {
    graph,
    config,
    sidecar,
    rawPeerDependencies: sidecar.peerDependencies ?? new Map<string, Record<string, string>>(),
    derivedPeersByNodeId: new Map<string, DerivedPeer[]>(),
    pendingDiagnostics: [],
    peerMeta: createPeerMetaContext(options),
    peerOptionalOverrides: new Map<string, boolean>(),
    peerChanged: false,
    peerMetaChanged: false,
    derivedPeerOptionalChanged: false,
  }
}

function yarnBerryPeerCandidates(
  graph: Graph,
  peerName: string,
  normalizedRange: string,
): string[] {
  return graph.byName(peerName)
    .filter(candidateId => {
      const candidate = graph.getNode(candidateId)
      return candidate !== undefined
        && semver.valid(candidate.version) !== null
        && semver.satisfies(candidate.version, normalizedRange)
    })
    .slice()
    .sort(cmpStr)
}

/** Resolve one raw peer declaration or retain a deterministic diagnostic. */
function deriveYarnBerryPeer(
  context: YarnBerryEnrichContext,
  node: Node,
  peerName: string,
  range: string,
  derivedPeers: DerivedPeer[],
): void {
  const normalizedRange = semver.validRange(range)
  if (normalizedRange === null) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: `invalid peer range for ${node.id}: ${peerName}@${range}`,
    })
  }
  const candidates = yarnBerryPeerCandidates(context.graph, peerName, normalizedRange)
  if (candidates.length === 1) {
    derivedPeers.push({ name: peerName, range, dstOldId: candidates[0]! })
    context.peerChanged = true
    return
  }
  if (candidates.length === 0) {
    context.pendingDiagnostics.push({
      code: `${context.config.codePrefix}_PEER_UNSATISFIED`,
      severity: 'warning',
      subject: node.id,
      message: `peer "${peerName}" range "${range}" matches no installed version`,
    })
    return
  }
  context.pendingDiagnostics.push({
    code: `${context.config.codePrefix}_PEER_AMBIGUOUS`,
    severity: 'warning',
    subject: node.id,
    peerName,
    candidateIds: candidates,
    message: ambiguousPeerMessage(peerName, candidates),
  })
}

/** Derive missing peer edges from the raw berry declaration sidecar. */
function collectYarnBerryDerivedPeers(context: YarnBerryEnrichContext): void {
  for (const node of context.graph.nodes()) {
    const rawPeers = context.rawPeerDependencies.get(node.id)
    if (rawPeers === undefined) continue
    if (node.peerContext.length > 0 || context.graph.out(node.id, 'peer').length > 0) continue
    const derivedPeers: DerivedPeer[] = []
    for (const [peerName, range] of Object.entries(rawPeers).sort((a, b) => cmpStr(a[0], b[0]))) {
      deriveYarnBerryPeer(context, node, peerName, range, derivedPeers)
    }
    if (derivedPeers.length > 0) context.derivedPeersByNodeId.set(node.id, derivedPeers)
  }
}

/** Reconstruct optional markers on peer edges that already exist. */
function collectYarnBerryPeerOptionalOverrides(context: YarnBerryEnrichContext): void {
  for (const node of context.graph.nodes()) {
    for (const edge of context.graph.out(node.id, 'peer')) {
      if (edge.attrs?.optional === true) continue
      const dst = context.graph.getNode(edge.dst)
      if (dst === undefined) continue
      const optional = resolvePeerOptional(
        context.graph,
        context.peerMeta,
        node,
        dst.name,
        context.pendingDiagnostics,
      )
      if (optional !== true) continue
      context.peerOptionalOverrides.set(peerEdgeKey(edge.src, edge.dst), true)
      context.peerMetaChanged = true
    }
  }
}

/** Reconstruct optional markers before adding newly derived peer edges. */
function markYarnBerryDerivedPeersOptional(context: YarnBerryEnrichContext): void {
  for (const [srcId, derivedPeers] of context.derivedPeersByNodeId) {
    const node = context.graph.getNode(srcId)
    if (node === undefined) continue
    for (const peer of derivedPeers) markYarnBerryDerivedPeerOptional(context, node, peer)
  }
}

function markYarnBerryDerivedPeerOptional(
  context: YarnBerryEnrichContext,
  node: Node,
  peer: DerivedPeer,
): void {
  const dst = context.graph.getNode(peer.dstOldId)
  const peerName = dst?.name ?? peer.name
  const nativeOptional = berryMetaPeerOptional(context.graph, node.id, peerName)
  const recoveredOptional = nativeOptional || resolvePeerOptional(
    context.graph,
    context.peerMeta,
    node,
    peerName,
    context.pendingDiagnostics,
  ) === true
  if (!recoveredOptional) return
  peer.optional = true
  context.derivedPeerOptionalChanged = true
}

function yarnBerryEnrichChanged(context: YarnBerryEnrichContext): boolean {
  return context.peerChanged
    || graphNeedsWorkspaceAttribution(context.graph)
    || context.peerMetaChanged
    || context.derivedPeerOptionalChanged
}

/** Re-key nodes after derived peer contexts become part of their identity. */
function createYarnBerryEnrichedNodes(context: YarnBerryEnrichContext): Map<string, Node> {
  const finalNodeIds = deriveFinalNodeIds(context.graph, context.derivedPeersByNodeId)
  const nextNodes = new Map<string, Node>()
  for (const node of context.graph.nodes()) {
    const derivedPeers = context.derivedPeersByNodeId.get(node.id)
    if (derivedPeers === undefined) {
      nextNodes.set(node.id, node)
      continue
    }
    const peerContext = sortPeerContext(derivedPeers.map(
      peer => finalNodeIds.get(peer.dstOldId) ?? peer.dstOldId,
    ))
    nextNodes.set(node.id, { ...node, id: finalNodeIds.get(node.id) ?? node.id, peerContext })
  }
  return nextNodes
}

function yarnBerryEnrichedEdgeAttrs(
  context: YarnBerryEnrichContext,
  edge: ReturnType<Graph['out']>[number],
): EdgeAttrs | undefined {
  let attrs = edge.attrs
  if (edge.kind !== 'peer' && edge.attrs?.workspace !== true && isDerivedWorkspaceRange(edge.attrs?.range)) {
    const dst = context.graph.getNode(edge.dst)
    if (dst?.workspacePath !== undefined) attrs = deriveMarkedWorkspaceAttrs(edge.attrs, dst)
  }
  if (edge.kind === 'peer' && context.peerOptionalOverrides.has(peerEdgeKey(edge.src, edge.dst))) {
    attrs = { ...(attrs ?? {}), optional: true }
  }
  return attrs
}

/** Copy existing adjacency through the re-key map and add canonical attrs. */
function addYarnBerryEnrichedEdges(
  context: YarnBerryEnrichContext,
  builder: YarnBerryGraphBuilder,
  nextNodes: Map<string, Node>,
): void {
  for (const node of context.graph.nodes()) {
    for (const edge of context.graph.out(node.id)) {
      builder.addEdge(
        nextNodes.get(edge.src)?.id ?? edge.src,
        nextNodes.get(edge.dst)?.id ?? edge.dst,
        edge.kind,
        yarnBerryEnrichedEdgeAttrs(context, edge),
      )
    }
  }
}

/** Add peer edges that were represented only by berry's declaration sidecar. */
function addYarnBerryDerivedPeerEdges(
  context: YarnBerryEnrichContext,
  builder: YarnBerryGraphBuilder,
  nextNodes: Map<string, Node>,
): void {
  for (const [srcOldId, derivedPeers] of context.derivedPeersByNodeId) {
    const srcNewId = nextNodes.get(srcOldId)?.id ?? srcOldId
    for (const peer of derivedPeers) {
      const dstNewId = nextNodes.get(peer.dstOldId)?.id ?? peer.dstOldId
      const attrs: EdgeAttrs = { range: peer.range }
      if (peer.optional === true) attrs.optional = true
      builder.addEdge(srcNewId, dstNewId, 'peer', attrs)
    }
  }
}

/** Copy payloads, diagnostics, and layout hints into the rebuilt graph. */
function copyYarnBerryEnrichMetadata(
  context: YarnBerryEnrichContext,
  builder: YarnBerryGraphBuilder,
): void {
  for (const node of context.graph.nodes()) {
    const payload = context.graph.tarballOf(node.id)
    if (payload === undefined) continue
    builder.setTarball({ name: node.name, version: node.version, patch: node.patch, source: node.source }, payload)
  }
  for (const diagnostic of context.graph.diagnostics()) builder.diagnostic(diagnostic)
  const layoutHints = context.graph.layoutHints()
  if (layoutHints !== undefined) builder.layoutHints(layoutHints)
}

/** Rebuild graph identity and remap every berry-only sidecar subject. */
function rebuildYarnBerryEnrichedGraph(
  context: YarnBerryEnrichContext,
): { graph: Graph; nextNodes: Map<string, Node> } {
  const nextNodes = createYarnBerryEnrichedNodes(context)
  const builder = newBuilder()
  for (const node of context.graph.nodes()) builder.addNode(nextNodes.get(node.id) ?? node)
  addYarnBerryEnrichedEdges(context, builder, nextNodes)
  addYarnBerryDerivedPeerEdges(context, builder, nextNodes)
  copyYarnBerryEnrichMetadata(context, builder)
  const graph = builder.seal()
  rememberSidecar(graph, remapSidecar(context.sidecar, nextNodes, graph))
  return { graph, nextNodes }
}

function finalizeYarnBerryEnrichDiagnostics(
  context: YarnBerryEnrichContext,
  nextNodes: Map<string, Node>,
): Diagnostic[] {
  return context.pendingDiagnostics.map(diagnostic => finalizePendingDiagnostic(diagnostic, nextNodes))
}

export function enrichFamily(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const context = createYarnBerryEnrichContext(graph, config, options)
  collectYarnBerryDerivedPeers(context)
  collectYarnBerryPeerOptionalOverrides(context)
  markYarnBerryDerivedPeersOptional(context)
  if (!yarnBerryEnrichChanged(context)) {
    return { graph, diagnostics: finalizeYarnBerryEnrichDiagnostics(context, new Map()) }
  }
  const rebuilt = rebuildYarnBerryEnrichedGraph(context)
  return {
    graph: rebuilt.graph,
    diagnostics: finalizeYarnBerryEnrichDiagnostics(context, rebuilt.nextNodes),
  }
}

export function optimizeFamily(
  graph: Graph,
  _options: YarnBerryFamilyOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  const result = optimizeUnreachable(graph, {
    seeds: Array.from(graph.roots()),
    compare: cmpStr,
    edgeSeparator: '\u0000',
    tarballInputs: node => ({
      name: node.name,
      version: node.version,
      patch: node.patch,
      source: node.source,
    }),
    skipMissingTarballs: false,
  })

  if (result.graph !== graph) rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  return result
}

export function rememberSidecar(graph: Graph, sidecar: YarnBerryFamilySidecar): void {
  if (isEmptySidecar(sidecar)) return
  sidecarByGraph.set(graph, sidecar)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sourceSidecar = sidecarByGraph.get(source)
  if (sourceSidecar === undefined) return { graph: target, invalidated: [] }
  const targetSidecar = sidecarByGraph.get(target)
  const pruned = pruneSidecar(targetSidecar ?? sourceSidecar, target)
  const sourceSubjects = new Set([
    ...(sourceSidecar.peerDependencies?.keys() ?? []),
    ...(sourceSidecar.conditions?.keys() ?? []),
    ...(sourceSidecar.dependenciesMeta?.keys() ?? []),
    ...(sourceSidecar.peerDependenciesMeta?.keys() ?? []),
    ...(sourceSidecar.unresolvedDeps?.keys() ?? []),
    ...(sourceSidecar.entryKeyDescriptors?.keys() ?? []),
  ])
  const invalidated = [...sourceSubjects].filter(id => target.getNode(id) === undefined).sort()
  rememberSidecar(target, pruned)
  return {
    graph: targetSidecar === undefined ? withSidecarPropagation(target, pruned) : target,
    invalidated,
  }
}

/**
 * Wraps a Graph so that every `.mutate()` call propagates the sidecar
 * (metadata, peerDependencies, conditions) to the resulting graph.
 *
 * Without this wrapper, `mutate()` returns a brand-new `Graph` instance
 * that has no entry in `sidecarByGraph`, causing `stringifyFamily` to fall
 * back to `EMPTY_SIDECAR` and drop `__metadata.cacheKey` (and any other
 * sidecar data) from the emitted lockfile.
 *
 * nodeId remapping (#114): a `replaceNode` / `replacePeerContext` that re-keys a
 * node drops its old id from the graph; the sidecar's per-node maps
 * (peerDependencies / conditions / *Meta / unresolvedDeps / entryKeyDescriptors)
 * are keyed by nodeId, so the old→new pair is read off the applied ChangeRecord
 * (`oldSubject`) and threaded through `remapSidecar` exactly as `enrichFamily`
 * does — but ONLY for an IDENTITY-PRESERVING rename (same `name@version[+…]`
 * base); a version/identity bump is left to reset (see the guard in `mutate`).
 */
function withSidecarPropagation(graph: Graph, sidecar: YarnBerryFamilySidecar): Graph {
  // Thin delegation proxy — only `mutate` is overridden; everything else
  // forwards to the underlying graph so the object is still a true Graph.
  const proxy: Graph = {
    getNode:      (...args) => graph.getNode(...args),
    nodes:        ()        => graph.nodes(),
    byName:       (...args) => graph.byName(...args),
    roots:        ()        => graph.roots(),
    out:          (...args) => graph.out(...args),
    in:           (...args) => graph.in(...args),
    walk:         (...args) => graph.walk(...args),
    topoSort:     ()        => graph.topoSort(),
    subgraph:     (...args) => graph.subgraph(...args),
    diff:         (...args) => graph.diff(...args),
    tarball:      (...args) => graph.tarball(...args),
    tarballOf:    (...args) => graph.tarballOf(...args),
    tarballs:     ()        => graph.tarballs(),
    diagnostics:  ()        => graph.diagnostics(),
    layoutHints:  ()        => graph.layoutHints(),
    mutate(transaction: (m: Mutator) => void): MutateResult {
      const result = graph.mutate(transaction)
      if (!isEmptySidecar(sidecar)) {
        // #114 — build the old→new NodeId map from the applied ChangeRecords so a
        // RENAMED node's per-NodeId sidecar (conditions / dependenciesMeta /
        // peerDependenciesMeta / peerDependencies / unresolvedDeps / verbatim
        // entry-key descriptors) follows it onto the new id, instead of being
        // dropped by `remapSidecar`'s membership prune (its old id is gone).
        //
        // CRITICAL NUANCE — carry the sidecar ONLY for an IDENTITY-PRESERVING
        // rename: one where the `name@version[+patch=][+src=]` base key is
        // unchanged (a peerContext shift — replacePeerContext, or a replaceNode
        // that only re-keys the peer suffix). A genuine VERSION/identity bump
        // (replaceNode to a new name@version) must NOT carry the old node's
        // sidecar: the old version's conditions / meta / key-descriptors do not
        // describe the new version, so that node legitimately RESETS to a fresh
        // key/sidecar reconstructed from live data (the C-KEYDROP-confirmed
        // behaviour). The base-key guard below leaves version bumps unmapped so
        // `remapSidecar`'s membership check prunes them.
        const nextNodes = new Map<string, Node>()
        for (const rec of result.applied) {
          if (rec.kind !== 'node-replaced' && rec.kind !== 'peer-context-replaced') continue
          const oldId = rec.oldSubject
          if (oldId === undefined) continue // id unchanged — no remap needed
          if (stripPeerContextFromNodeId(oldId) !== stripPeerContextFromNodeId(rec.subject)) {
            continue // identity/version change — reset, do not carry the old sidecar
          }
          const newNode = result.graph.getNode(rec.subject)
          if (newNode !== undefined) nextNodes.set(oldId, newNode)
        }
        // `remapSidecar` rewrites each per-node key through `nextNodes.get(oldId)?.id`
        // and keeps it iff the new id is a live node; metadata (cacheKey etc.) is
        // global and carries unconditionally. An old id absent from `nextNodes` (a
        // version bump, or any non-rename) still falls back to its own id and is
        // pruned by the membership check when that id is gone — unchanged behaviour.
        const nextSidecar = remapSidecar(sidecar, nextNodes, result.graph)
        // If remapSidecar pruned everything (replaced nodes), fall back to at least
        // preserving the format-level metadata (cacheKey, compressionLevel, etc.)
        // which is not node-keyed and should always survive any mutation.
        const effectiveSidecar: YarnBerryFamilySidecar = isEmptySidecar(nextSidecar) && sidecar.metadata !== undefined
          ? { metadata: sidecar.metadata }
          : nextSidecar
        // Keep the verbatim entry-key descriptor sidecar in sync with the edge
        // mutations this transaction applied: a bumped consumer's dropped edge
        // retires its descriptor from the dst entry's key; a completion-added
        // edge contributes its descriptor. Acts ONLY on the edges that actually
        // changed, so untouched entries (incl. un-edge-backed descriptors the
        // edges never carried — `^3`, `*`) re-emit byte-faithfully, while a
        // mutated entry no longer drifts into a key `yarn install --immutable`
        // rewrites (§1.1.1).
        const maintainedSidecar = maintainEntryKeyDescriptors(effectiveSidecar, result.applied, graph, result.graph)
        rememberSidecar(result.graph, maintainedSidecar)
        return {
          ...result,
          graph: withSidecarPropagation(result.graph, maintainedSidecar),
        }
      }
      return result
    },
  }
  // Register the sidecar on the proxy instance too so that stringify works
  // when called with the proxy directly (not just with the underlying graph).
  sidecarByGraph.set(proxy, sidecar)
  return proxy
}

export function rawPeerDependenciesBlockOfNode(graph: Graph, nodeId: string): SymlMap | undefined {
  const peerDependencies = sidecarByGraph.get(graph)?.peerDependencies?.get(nodeId)
  return peerDependencies === undefined ? undefined : coerceSymlMap(peerDependencies)
}

export function rawConditionsScalarOfNode(graph: Graph, nodeId: string): string | undefined {
  return sidecarByGraph.get(graph)?.conditions?.get(nodeId)
}

/** Whether a berry entry is keyed only by npm-alias descriptors and has no
 * conditions. Yarn leaves these alias-only entries without their own checksum;
 * the resolved target locator is the checksum-bearing identity. Same-format
 * only: the verbatim entry-key sidecar is intentionally adapter-local. */
export function isBareYarnBerryNpmAliasNode(graph: Graph, nodeId: string): boolean {
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar?.conditions?.has(nodeId) === true) return false
  const node = graph.getNode(nodeId)
  const descriptors = sidecar?.entryKeyDescriptors?.get(nodeId)
  if (node === undefined || descriptors === undefined || descriptors.length === 0) return false
  return descriptors.every(descriptor => {
    const spec = parseSpec(descriptor)
    return spec.protocol === 'npm'
      && spec.name !== node.name
      && spec.spec.startsWith(`${node.name}@`)
  })
}

export interface YarnBerryConditionsFeatureQuery {
  readonly available: boolean
  readonly present: boolean
  readonly fingerprint?: string
}

/** Read-only conditions feature query for completeness assessment. */
export function yarnBerryConditionsFeatureOf(graph: Graph): YarnBerryConditionsFeatureQuery {
  const sidecar = sidecarByGraph.get(graph)
  const conditions = sidecar?.conditions
  const entries = conditions === undefined
    ? undefined
    : [...conditions.entries()].sort(([left], [right]) => left.localeCompare(right))
  return {
    available: sidecar !== undefined,
    present: entries !== undefined && entries.length > 0,
    ...(entries === undefined || entries.length === 0
      ? {}
      : { fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }),
  }
}

export function rawDependenciesMetaBlockOfNode(graph: Graph, nodeId: string): SymlMap | undefined {
  const block = sidecarByGraph.get(graph)?.dependenciesMeta?.get(nodeId)
  return block === undefined ? undefined : coerceSymlMap(block)
}

// yarn-berry has NO `optionalDependencies:` block: an optional dep lives in the
// `dependencies:` map and is flagged via `dependenciesMeta.<name>.optional = true`
// (spec/formats/_common.md §1.4 — a separate map makes yarn reject the lock on
// `install --immutable`). Parsed berry nodes already hold their optional deps as
// `dep` edges + a verbatim dependenciesMeta sidecar, so they surface no `optional`
// edges here and round-trip untouched. `optional`-KIND edges only arise from
// completion (a registry optionalDependency) or a cross-family convert
// (npm/pnpm → berry); for those, synthesise the flag so the folded `dependencies`
// entry is read back as optional. The key matches the emitted dep key
// (`alias ?? dst.name`, per edgeBlockOfKinds). Verbatim flags win a collision
// (fidelity); synthesis only fills a name the sidecar didn't already cover. The
// merged block is name-sorted to match yarn's alphabetical inner-block order.
function dependenciesMetaWithOptional(
  graph: Graph,
  node: Node,
  verbatim: SymlMap | undefined,
): SymlMap | undefined {
  const optionalNames: string[] = []
  for (const edge of graph.out(node.id, 'optional')) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    optionalNames.push(edge.attrs?.alias ?? dst.name)
  }
  if (optionalNames.length === 0) return verbatim

  const merged: SymlMap = {}
  if (verbatim !== undefined) {
    for (const [name, meta] of Object.entries(verbatim)) merged[name] = meta
  }
  for (const name of optionalNames) {
    if (name in merged) continue   // verbatim flag wins
    merged[name] = { optional: 'true' }
  }
  const sorted: SymlMap = {}
  for (const name of Object.keys(merged).sort(cmpStr)) sorted[name] = merged[name]!
  return sorted
}

export function rawPeerDependenciesMetaBlockOfNode(graph: Graph, nodeId: string): SymlMap | undefined {
  const block = sidecarByGraph.get(graph)?.peerDependenciesMeta?.get(nodeId)
  return block === undefined ? undefined : coerceSymlMap(block)
}

// F8/#103 — verbatim Rung-4-dropped dep refs for `nodeId` that belong to the
// given emit block (`dependencies` / `optionalDependencies`). Folded into the
// live-edge block on emit so a same-format round-trip re-emits them byte-for-byte.
function unresolvedDepRefsOfNode(
  graph: Graph,
  nodeId: string,
  block: 'dependencies' | 'optionalDependencies',
): UnresolvedDepRef[] {
  const refs = sidecarByGraph.get(graph)?.unresolvedDeps?.get(nodeId)
  return refs === undefined ? [] : refs.filter(ref => ref.block === block)
}

/**
 * Pull the package name out of an `npm:` resolution locator
 * (`<name>@npm:<version>`). Returns undefined for any non-yarn-locator
 * shape — bare URLs (yarn-classic cross-format input), git resolutions,
 * workspace/patch protocols, `unknown`-canonical sentinels — so the
 * caller falls back to the entry-key's `first.name`.
 *
 * Restricted to the `<name>@npm:<rest>` shape: only when parseSpec returns
 * protocol === 'npm' AND the name looks like a package identifier (no
 * URL-host shape like `https://...`). Cross-format inputs frequently
 * carry a tarball URL as the resolution string; parseSpec's `@` scan
 * happily eats the URL's `@` at the host boundary, so the protocol-only
 * test is insufficient.
 */
export function nameFromResolutionLocator(resolution: string): string | undefined {
  // Bail on URL-shaped strings — only yarn-berry locators
  // (`<name>@<protocol>:...`) carry an authoritative package name.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolution)) return undefined
  try {
    const part = parseSpec(resolution)
    if (part.protocol !== 'npm') return undefined
    // Sanity: the name slot must look like an npm package name (no
    // path separators / URL host artifacts). Scoped names allowed.
    if (part.name.includes('/') && !part.name.startsWith('@')) return undefined
    if (part.name.includes(':')) return undefined
    return part.name
  } catch {
    return undefined
  }
}

function parseSpec(raw: string): SpecPart {
  const startFrom = raw[0] === '@' ? 1 : 0
  let sepIdx = -1
  for (let i = startFrom; i < raw.length; i++) {
    if (raw[i] === '@') { sepIdx = i; break }
  }
  if (sepIdx <= 0) {
    throw new LockfileError({
      code: 'PARSE_FAILED',
      message: `bad entry-spec, no protocol separator: ${raw}`,
    })
  }
  const name = raw.slice(0, sepIdx)
  const rest = raw.slice(sepIdx + 1)
  const colon = rest.indexOf(':')
  // Yarn 4 occasionally emits a bare `<name>@<version>` half in a compound
  // entry-key when a workspace package is also published to the npm registry
  // (e.g. `"@scope/pkg@1.14.1, @scope/pkg@workspace:packages/pkg"`), and a
  // GitHub-shorthand half (`pem@dexus/pem` — #119 NIT A). `rest` (the verbatim
  // range) is carried on `raw` so the specIndex key is built through the shared
  // `entryKeyRangeOf` normalisation: a bare semver gets `npm:`, a GitHub
  // shorthand stays verbatim — keeping the key aligned with the edge lookup.
  if (colon < 0) {
    return { name, protocol: 'npm', spec: rest, raw: rest }
  }
  return { name, protocol: rest.slice(0, colon), spec: rest.slice(colon + 1), raw: rest }
}

function parseEntryKey(key: string): SpecPart[] {
  return key.split(', ').map(spec => parseSpec(spec.trim()))
}

function workspacePathOf(spec: string): string {
  if (spec === '.') return ''
  if (spec.startsWith('./')) return spec.slice(2)
  return spec
}

// Workspace-spec discriminator: returns the workspace-protocol spec body
// (path or range marker) for an entry IFF the entry represents a workspace
// member. The canonical signal is the `resolution` field (`<n>@workspace:<path>`,
// per ADR-0014 §4.F3 — workspace identity is per-format and lives on
// `Node.workspacePath`); compound entries (e.g. `<n>@npm:<ver>, <n>@workspace:<path>`)
// may list an `npm:` alias ahead of the `workspace:` spec lexically, so
// keying off `specs[0].protocol` misclassifies the entry as non-workspace
// and breaks ADR-0017 seal (`workspace node has incoming edges` because
// the source workspace lost its `workspacePath`). Order of precedence:
//
// 1. parse `resolution` if present and prefixed with `<n>@workspace:`
//    — single canonical, immune to spec ordering;
// 2. otherwise scan all specs for `protocol === 'workspace'` and prefer the
//    one with a concrete path (not the range markers `^`, `~`, `*`) so
//    `workspacePath` is the filesystem location, not a range;
// 3. otherwise fall back to `first.spec` when `first.protocol === 'workspace'`
//    — legacy single-spec workspace shape, kept for parity.
export function workspaceSpecOfEntry(
  resolution: string | undefined,
  specs: SpecPart[],
  first: SpecPart,
): string | undefined {
  if (resolution !== undefined) {
    const colon = resolution.indexOf('@workspace:')
    if (colon > 0) return resolution.slice(colon + '@workspace:'.length)
  }
  const workspaceSpecs = specs.filter(s => s.protocol === 'workspace')
  const withPath = workspaceSpecs.find(s => s.spec !== '^' && s.spec !== '~' && s.spec !== '*')
  if (withPath !== undefined) return withPath.spec
  if (workspaceSpecs.length > 0) return workspaceSpecs[0]!.spec
  return first.protocol === 'workspace' ? first.spec : undefined
}

function asMap(value: SymlValue | undefined): SymlMap | undefined {
  return value && typeof value === 'object' ? value : undefined
}

function asString(value: SymlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function validateMetadata(ast: SymlMap, config: YarnBerryFamilyConfig): SymlMap | undefined {
  const meta = asMap(ast['__metadata'])
  if (!meta) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'missing __metadata block',
    })
  }
  if (asString(meta['version']) !== String(config.lockfileVersion)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `expected __metadata.version: ${config.lockfileVersion}, got ${JSON.stringify(meta['version'])}`,
    })
  }

  const extras: SymlMap = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'version') continue
    const cloned = cloneSymlValue(value)
    if (cloned !== undefined) {
      extras[key] = cloned
    }
  }
  return Object.keys(extras).length > 0 ? extras : undefined
}

function entryKeyOfNode(graph: Graph, node: Node): string {
  // B-EXACT — same-format round-trip: re-emit the VERBATIM source key descriptors
  // (captured at parse) so the key is byte-identical to what yarn wrote (an
  // ordinary range entry stays range-only; a genuine resolutions-pin keeps its
  // exact descriptor). Absent only for nodes the graph minted or REPLACED
  // (cross-PM convert, hand-built node, a version-bump `replaceNode` whose new id
  // dropped the sidecar) — those fall through to edge-reconstruction below.
  const verbatim = sidecarByGraph.get(graph)?.entryKeyDescriptors?.get(node.id)
  if (verbatim !== undefined && verbatim.length > 0) {
    return verbatim.join(', ')
  }

  // Reconstruction fallback. The node's SELF-descriptor (a `workspace:` path or a
  // `patch:` locator) is a key descriptor yarn ALWAYS writes, so it is unconditional.
  // For a plain registry node there is NO self-descriptor: yarn keys it purely by
  // the referencing RANGE(s), and the resolved-version locator is NEVER a key
  // descriptor — so the exact `<name>@npm:<version>` is used only as a LAST-RESORT
  // anchor when the node has no incoming-edge descriptor (keeping reparse bindable),
  // never prepended alongside real ranges (the B-EXACT synthesis bug).
  const payload = graph.tarballOf(node.id)
  const native = payload?.nativeResolution
  const self = selfDescriptorOfNode(node, native)
  const specs = new Set<string>()
  if (self !== undefined) specs.add(self)
  const patchBase = baseSpecOfPatchedNode(node, native)
  if (patchBase !== undefined) specs.add(patchBase)

  for (const edge of graph.in(node.id)) {
    if (edge.kind === 'peer') continue
    if (edge.attrs?.range !== undefined) {
      // Aliased incoming edge — its descriptor key in the parent's
      // dependencies block is the alias, not `node.name`. The entry-key
      // half must reflect that so reparse `specIndex.set` registers the
      // alias lookup correctly. Canonical (non-aliased) edges keep the
      // node's actual name.
      const specName = edge.attrs.alias ?? node.name
      // A completed/mutated edge governed by an override carries the pin as
      // `overrideRange`; yarn keys the entry by the pin (collapsing the descriptor),
      // not the raw declared range (else `--immutable` YN0028). Non-aliased only.
      const keyRange = edge.attrs.alias === undefined ? (edge.attrs.overrideRange ?? edge.attrs.range) : edge.attrs.range
      const secondary = `${specName}@${entryKeyRangeOf(keyRange)}`
      // Bug #90 — a `link:`/`portal:`/`file:` consumer records the dep BARE
      // (`link:packages/x`) in its dependencies block while yarn keys the
      // resolved entry with a `::locator=<consumer>` qualifier
      // (`link:packages/x::locator=…`). Reparse re-qualifies the bare consumer
      // edge from the consumer's own resolution (addEdgesFromBlock), so the
      // bare incoming-edge range survives on `attrs.range`. Re-emitting it as a
      // secondary descriptor would APPEND a spurious bare
      // `<name>@link:packages/x` to the entry key (descriptor count 2→3) — a
      // shape yarn never writes (the entry key is the single qualified spec).
      // Suppress the bare secondary IFF it is exactly the unqualified prefix of
      // the node's `::locator=`-qualified self-descriptor; that descriptor already
      // covers this consumer (and reparse re-derives the qualifier).
      if (self === undefined || !isLocatorQualifiedPrefix(self, secondary)) {
        specs.add(secondary)
      }
    }
  }

  // NAME-ANCHOR fallback. On reparse the entry's canonical name is recovered as
  // `nameFromResolutionLocator(resolution) ?? first.name` — so a node whose
  // resolution is NON-`npm:` (git / file / http) and whose key descriptors all
  // carry an ALIAS name (a cross-PM convert that collapsed git aliases onto one
  // `<name>@<version>` node — `is-git@…`, `is-github@…` vs name `@scope/is`) would
  // reparse under the wrong name and lose its node identity. Add a
  // `<name>@npm:<version>` descriptor IFF no key descriptor already carries
  // `<name>@`, so reparse can recover the name. This NEVER fires for an ordinary
  // registry node (its range descriptors are `<name>@npm:<range>`, already
  // name-carrying) — so the B-EXACT exact-version synthesis stays removed — and a
  // same-format round-trip re-keys verbatim via the sidecar above (this path is
  // only reached for cross-PM converts and hand-built / mutated-replaced nodes).
  // Also covers the zero-descriptor orphan (a registry pin whose only consumer
  // dropped) — it gets a bindable key.
  //
  // TARBALL SYNTHESIS (cross-format convert): a NON-default-registry or
  // `::`-bound tarball synth node anchors on the SAME `::__archiveUrl=…` locator
  // its `resolution:` carries (via `synthesisedBerryTarballLocator`), NOT the bare
  // `<name>@npm:<version>` — otherwise a registry copy and a private-registry copy
  // at the same name@version both anchor on the identical `<name>@npm:<version>`
  // key and the second silently overwrites the first on emit. A default-registry
  // synth node (and the non-tarball cases) keep the plain `<name>@npm:<version>`
  // anchor.
  if (!Array.from(specs).some(spec => spec.startsWith(`${node.name}@`))) {
    specs.add(synthesisedBerryTarballLocator(node, payload?.resolution) ?? `${node.name}@npm:${node.version}`)
  }

  // B-EXACT round-trip: re-emit the VERBATIM source key (parse-captured) to keep
  // byte-identical source order and a genuine resolutions-pin's exact descriptor.
  // EXCEPTION — a PLAIN REGISTRY node (no `workspace:`/`patch:` self-descriptor)
  // whose incoming-edge set DIVERGED from the source key: a bump added or dropped
  // a consumer, so the verbatim key is stale (a range yarn would rewrite under
  // `--immutable`). Those fall through to the content-sorted edge reconstruction
  // (matches yarn's lexical order). Workspace / patch nodes keep verbatim
  // unconditionally — their source key carries bare-version / locator descriptors
  // the edge reconstruction does not reproduce byte-for-byte.
  // Stable, content-sorted key (matches yarn's lexical multi-descriptor order;
  // verbatim source order is preserved by the sidecar path above).
  return Array.from(specs).sort(cmpStr).join(', ')
}

// Bug #90 — is `secondary` exactly the unqualified prefix of a
// `::locator=`-qualified `primary` (`<…>@link:packages/x` vs
// `<…>@link:packages/x::locator=<consumer>`)? Such a `secondary` is the BARE
// descriptor a consumer records for a `link:`/`portal:`/`file:` dep whose
// resolved entry yarn keyed with the `::locator=` ownership qualifier. The
// qualified primary already represents this consumer (and reparse re-derives
// the qualifier from the consumer's resolution), so the bare secondary is a
// spurious duplicate and must not join the entry key. Matched structurally
// (prefix + literal `::locator=`) so it ONLY fires for the locator-qualified
// local-protocol case — a plain `npm:`/`workspace:` secondary, or a bare-link
// node whose primary is itself unqualified (secondary === primary, already
// filtered), is unaffected.
function isLocatorQualifiedPrefix(primary: string, secondary: string): boolean {
  return primary.startsWith(`${secondary}::locator=`)
}

// The node's SELF-descriptor — a key descriptor yarn ALWAYS writes for the entry
// because it is an EXACT locator, not a referencing range. Returns:
//   - workspace node → `<name>@workspace:<path>` (the canonical workspace key);
//   - `patch:` node  → the full `@patch:` locator (the patch entry's key);
//   - git / file / http / any non-`npm:` resolution → the resolution locator
//     verbatim (an exact locator, e.g. `forky@https://github.com/o/forky.git#…`);
//   - plain `npm:` REGISTRY node → `undefined`. This is the B-EXACT distinction:
//     a registry entry is keyed by the referencing RANGE(s); its
//     `<name>@npm:<exact-version>` resolution is NEVER a key descriptor, so it
//     must not be force-added (the resolved version lives in `version:`/
//     `resolution:`). `entryKeyOfNode` falls back to the exact locator ONLY when
//     no incoming-edge descriptor exists (a bindable last-resort anchor).
function selfDescriptorOfNode(node: Node, native: string | undefined): string | undefined {
  if (node.workspacePath !== undefined) {
    return `${node.name}@workspace:${node.workspacePath === '' ? '.' : node.workspacePath}`
  }
  if (native === undefined) return undefined
  if (native.startsWith(`${node.name}@patch:`)) return native
  // A plain `npm:` registry resolution is the resolved version, NOT a key
  // descriptor — exclude it so it is never synthesized into the key.
  if (native.startsWith(`${node.name}@npm:`)) return undefined
  // Any other locator-shaped resolution (git / file / http / portal / link) IS
  // the exact key descriptor yarn writes for the entry.
  return native.startsWith(`${node.name}@`) ? native : undefined
}

function baseSpecOfPatchedNode(node: Node, native: string | undefined): string | undefined {
  if (native === undefined || !native.startsWith(`${node.name}@patch:`)) return undefined
  const locator = patchLocatorOfResolution(native)
  if (locator === undefined) return undefined
  return baseSpecOfPatchLocator(locator)
}

export function baseSpecOfPatchLocator(locator: string): string | undefined {
  if (!locator.startsWith('patch:')) return undefined
  const hashIdx = locator.indexOf('#')
  const encoded = hashIdx >= 0
    ? locator.slice('patch:'.length, hashIdx)
    : locator.slice('patch:'.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

// #95 — yarn's per-entry `linkType` (`soft` | `hard`), derived from the emitted
// resolution locator. Mirrors yarn's fetcher dispatch (`yarnpkg-core`): the
// `LinkFetcher`/`PortalFetcher`/`WorkspaceFetcher` report `LinkType.SOFT` (the
// package is symlinked IN PLACE — its bytes are never copied), and the
// `FileFetcher` reports `SOFT` for a `file:` DIRECTORY link but `HARD` for a
// `file:` archive (a `.tgz`/`.tar.gz` it extracts into the cache). Every other
// source — registry `npm:`, `git`/`https`, and a `patch:` of ANY base (a
// patched copy is materialised into the cache, so `patch:` is `hard` even when
// its `::locator=` names a workspace — verified on backstage/yarnpkg-berry) —
// is `hard`. Workspace members are handled by the caller (`node.workspacePath`)
// and never reach here.
//
// The protocol is read from the EMITTED locator (`<name>@<protocol>:<spec>`) so
// the rule is correct for cross-PM converts too (an npm/pnpm `file:` directory
// link emits as `<name>@portal:<path>`). A locator we cannot peel (a bare URL
// from a leaked cross-format sidecar) falls through to `hard`, the safe default
// for a copied/extracted artefact.
// Terminator includes `:` so a `.tgz` archive followed by a `::<params>` bind
// (e.g. `file:./vendor/x.tgz::locator=…`) is still recognised as an archive
// (→ `hard`); without it the `::` tail fell through to the `soft` default.
const ARCHIVE_PATH_RE = /\.(?:tgz|tar\.gz|tar)(?:$|[#?:])/i
export function linkTypeOfResolution(resolution: string | undefined): 'soft' | 'hard' {
  if (resolution === undefined) return 'hard'
  let part: SpecPart
  try {
    part = parseSpec(resolution)
  } catch {
    return 'hard'
  }
  switch (part.protocol) {
    case 'link':
    case 'portal':
      // Always an in-place directory symlink → soft.
      return 'soft'
    case 'file':
      // `file:` is soft for a directory link, hard for an extracted archive.
      // The spec body may carry a `#<hash>`/`::<params>` tail — the archive
      // test anchors on the path segment's extension before any such tail.
      return ARCHIVE_PATH_RE.test(part.spec) ? 'hard' : 'soft'
    default:
      return 'hard'
  }
}

function entryOfNode(
  graph: Graph,
  node: Node,
  config: YarnBerryFamilyConfig,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
  cacheKey: string | undefined,
): SymlMap {
  const payload = graph.tarballOf(node.id)
  const entry: SymlMap = {
    version: node.version,
    resolution: resolutionOfNode(node, payload?.resolution, payload?.nativeResolution, emitDiagnostic),
  }

  // yarn-berry's on-disk format has a single `dependencies:` block per entry —
  // no separate `devDependencies` OR `optionalDependencies` block. ADR-0019 §C
  // derives `dev` edges at the workspace root from manifests; `optional` deps
  // fold in too and carry their optional-ness via `dependenciesMeta.<name>.optional`
  // below (spec/formats/_common.md §1.4 — a real berry lock NEVER writes a
  // separate `optionalDependencies` map; yarn rejects one on `install --immutable`,
  // YN0028). Merge all three kinds on emit so the classification survives
  // stringify (parse collapses `dev`/`optional` back per §C + the dependenciesMeta
  // sidecar). F8/#103 — fold any verbatim Rung-4-dropped refs (target absent from
  // the lock) back into the SAME block so a same-format round-trip is byte-faithful
  // (re-sorted by name with the live edges to match yarn's alphabetical order).
  const dependencies = withUnresolvedDepRefs(
    edgeBlockOfKinds(graph, node, ['dep', 'dev', 'optional'], config),
    unresolvedDepRefsOfNode(graph, node.id, 'dependencies'),
  )
  if (dependencies !== undefined) entry['dependencies'] = dependencies

  const peerDependencies = extraBlockOfNode(node, 'peerDependencies')
    ?? rawPeerDependenciesBlockOfNode(graph, node.id)
    ?? coerceSymlMap(payload?.peerDependencies)                 // completion-added node
    ?? edgeBlockOfKinds(graph, node, ['peer'], config, { skipMissingRange: true })
  if (peerDependencies !== undefined) entry['peerDependencies'] = peerDependencies

  // Canonical yarn schedule places `dependenciesMeta` BEFORE `peerDependenciesMeta`
  // (verified against real berry locks, e.g. @angular-devkit/build-angular). Both
  // round-trip from the per-node raw sidecar captured at parse, with the legacy
  // node-field hint kept as a fallback for hand-built nodes.
  // Optional deps folded into `dependencies` above are flagged here via
  // `dependenciesMeta.<name>.optional = true`. Parsed berry nodes already hold
  // this verbatim (their optional deps are `dep` edges); `optional`-KIND edges
  // (completion / cross-family convert) get the flag synthesised.
  const dependenciesMeta = dependenciesMetaWithOptional(
    graph, node,
    rawDependenciesMetaBlockOfNode(graph, node.id) ?? extraBlockOfNode(node, 'dependenciesMeta'),
  )
  if (dependenciesMeta !== undefined) entry['dependenciesMeta'] = dependenciesMeta

  const peerDependenciesMeta = peerDependenciesMetaOfNode(graph, node, payload)
  if (peerDependenciesMeta !== undefined) entry['peerDependenciesMeta'] = peerDependenciesMeta

  const bin = binBlockOfNode(node, payload)
  if (bin !== undefined) entry['bin'] = bin

  // Trailing-field schedule is FIXED by yarn's emitter and verified byte-for-byte
  // against the real-world berry corpus (v4–v10, ~50k entries, zero inversions):
  //   … bin, checksum, conditions, languageName, linkType
  // (#117). `checksum` precedes `conditions`, which precedes `languageName`, which
  // precedes `linkType`. Any other interleaving breaks byte-fidelity and
  // `yarn install --immutable` on essentially every entry. The blocks above
  // (dependencies, peerDependencies, dependenciesMeta, peerDependenciesMeta) keep
  // yarn's `Manifest.exportTo` order. There is deliberately NO `optionalDependencies`
  // block — optional deps fold into `dependencies` + `dependenciesMeta` (§1.4).
  const checksum = checksumOfPayload(payload, config, cacheKey, node.id, emitDiagnostic)
  if (checksum !== undefined) entry['checksum'] = checksum

  // `conditions:` is a SCALAR token (`os=darwin & cpu=arm64`, possibly with
  // `( | )` groups) — emitted verbatim, NOT as a structured block. The captured
  // scalar wins; a string node-field hint is the hand-built fallback. The syml
  // writer would quote it (spaces/`&`), so `stringifyFamily` post-unquotes the
  // `conditions:` lines to match yarn's bare emit (corrects ADR-0018 §A.v5).
  const conditions = rawConditionsScalarOfNode(graph, node.id)
    ?? scalarConditionsHintOfNode(node)
    ?? composeConditionsFromPayload(payload)
  if (conditions !== undefined) {
    if (config.conditionsAllowed) {
      entry['conditions'] = conditions
    } else {
      emitDiagnostic({
        code: `${config.codePrefix}_CONDITIONS_DROPPED`,
        subject: node.id,
        severity: 'warning',
        message: `conditions is unsupported in yarn-berry-v${config.lockfileVersion}; dropping on emit`,
      })
    }
  }

  entry['languageName'] = node.workspacePath !== undefined ? 'unknown' : 'node'
  // #95 — `linkType` is `soft` for filesystem-IN-PLACE sources (the package
  // lives at its original location and is symlinked) and `hard` for everything
  // yarn copies/extracts into its cache (registry tarball, git, local tarball,
  // patch). Derived from the EMITTED resolution locator so it is correct for
  // both same-format sentinels (the per-tarball `nativeResolution` carries the
  // verbatim `link:`/`portal:` locator) AND a cross-PM directory→`portal:`
  // convert (no `nativeResolution`, but `entry.resolution` is the `portal:` locator we just
  // emitted). See `linkTypeOfResolution` for the exact soft set (verified
  // byte-for-byte against babel/backstage/storybook/yarnpkg-berry real locks).
  entry['linkType'] = node.workspacePath !== undefined
    ? 'soft'
    : linkTypeOfResolution(asString(entry['resolution']))

  if (node.peerContext.length > 0) {
    emitDiagnostic({
      code: `${config.codePrefix}_PEER_VIRT_FLATTENED`,
      subject: node.id,
      severity: 'warning',
      message: `peerContext ${JSON.stringify(node.peerContext)} flattens to ${entry.resolution}`,
    })
  }

  return entry
}

// A genuine berry locator for THIS node begins with `<name>@` (incl. an npm
// alias `<name>@npm:<other>@<ver>`); a foreign sidecar leaked by a cross-format
// source is a bare URL (`https://…`) and must be re-synthesised before emit.
function isBerryLocatorOfNode(native: string, name: string): boolean {
  return native.startsWith(`${name}@`)
}

// Synthesise a valid berry npm locator from a `tarball` canonical when no berry
// sidecar exists (cross-format convert). Default-registry → clean
// `<name>@npm:<version>`; non-registry/bound → `…::<bind>` (reusing
// `canonical.bind`, else `__archiveUrl=<enc>`) so source-siblings fork on
// re-parse instead of collapsing onto a bare invalid URL. Gated on
// `sourceDiscriminatorOf` so the registry split matches the node's `+src=` slot;
// non-`tarball` canonicals keep their own emit paths.
function synthesisedBerryTarballLocator(node: Node, canonical: ResolutionCanonical | undefined): string | undefined {
  if (canonical === undefined || canonical.type !== 'tarball') return undefined
  if (sourceDiscriminatorOf(canonical) === undefined) {
    return `${node.name}@npm:${node.version}`
  }
  const bind = canonical.bind ?? `__archiveUrl=${encodeURIComponent(canonical.url)}`
  return `${node.name}@npm:${node.version}::${bind}`
}

function resolutionOfNode(
  node: Node,
  canonical: ResolutionCanonical | undefined,
  native: string | undefined,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): string {
  if (node.patch !== undefined) {
    // Intra-family path: parse-side carries the verbatim `@patch:` locator
    // on the per-tarball `nativeResolution`. If it survived to emit, stringify
    // it directly — patch identity round-trips losslessly regardless of whether
    // `node.patch` is canonical (128-hex sha512) or sentinel
    // (`unresolved-<sha256>`).
    if (native !== undefined && patchLocatorOfResolution(native) !== undefined) {
      return native
    }
    // Local-artefact locator-disambiguator path: the patch slot is a sentinel
    // keyed off the locator string (parse-side disambiguation per ADR-0011),
    // NOT a real patch — covers `link:` / `portal:` references AND a
    // `::locator=`-qualified `file:` local-tarball alias (Bug #76). The
    // verbatim resolution carries the locator + `::locator=` qualifier intact,
    // so round-trip is lossless — no `RECIPE_FEATURE_DROPPED` to emit.
    if (native !== undefined && isLocalLocatorDisambiguatedResolution(native, node.name)) {
      return native
    }
    // Cross-family / mutate path: no reconstructable yarn `patch:` locator
    // is available on the Graph. Two cases collapse here:
    //   - Sentinel `unresolved-<sha256>`: input is per-PM (pnpm hashes
    //     `<name>@<version>:<literalKey>`; yarn hashes the locator
    //     verbatim — ADR-0011), so the byte-identity is unrecoverable.
    //   - Canonical 128-hex sha512 (F2): byte-identity exists, but yarn
    //     locators encode source-path + version params, which the canonical
    //     hex carries no path info to reconstruct.
    // Either way, per ADR-0014 §5 graceful-degradation precedent, emit
    // `RECIPE_FEATURE_DROPPED (feature='patch')` and fall through to emit
    // the base resolution without a patch directive.
    emitDropped(
      node.id,
      'patch',
      'patched node lacks reconstructable yarn patch: locator',
      emitDiagnostic,
    )
    // fall through to base-resolution emit
  }

  // PM-native sidecar wins for same-format round-trip; cross-format input
  // delivers a foreign shape (URL / pnpm `link:`), which yarn-berry passes
  // through verbatim. Re-parse populates the canonical from the verbatim
  // string per ADR-0014 §4.F3, so identity survives the conversion even
  // when the source-side adapter's sidecar leaks through.
  //
  // CANONICAL-NATIVE RECOMPOSE (load-bearing): a canonical npm-registry node
  // stores NO `nativeResolution` (the parse-side OMISSION above), so `native`
  // is undefined here. Its canonical resolution is `{type:'tarball', url}`
  // (the registry tarball), recomposed below to the exact `name@npm:version`
  // line. The bare-`npm:` fallback at the end covers a node with neither native
  // nor canonical (a hand-built graph), keeping the prior behaviour.
  //
  // TARBALL SYNTHESIS (cross-format convert): when `native` is a FOREIGN bare
  // URL leaked by a yarn-classic/npm/pnpm source sidecar — NOT a berry locator —
  // returning it verbatim emits a structurally-invalid `resolution:` (a bare URL
  // is not a `<name>@<protocol>:<spec>` locator). For a `tarball` canonical,
  // re-synthesise a valid berry npm locator instead: a default-registry copy
  // becomes `<name>@npm:<version>`, a non-registry/bound copy folds its host into
  // `::__archiveUrl=…` so a registry sibling and a private-registry sibling at the
  // SAME name@version stay distinct + valid. A genuine berry locator (`native`
  // begins with `<name>@`, incl. git/patch/file/alias) still passes through
  // verbatim, so the berry→berry round-trip is unchanged.
  if (native !== undefined && isBerryLocatorOfNode(native, node.name)) return native
  if (node.workspacePath !== undefined) {
    return `${node.name}@workspace:${node.workspacePath === '' ? '.' : node.workspacePath}`
  }
  const synthesised = synthesisedBerryTarballLocator(node, canonical)
  if (synthesised !== undefined) return synthesised
  // A foreign non-tarball native (e.g. a leaked git/file URL the canonical could
  // not classify as tarball) still round-trips verbatim through the recipe.
  if (native !== undefined) return native
  if (canonical !== undefined) {
    return stringifyForYarnBerry(canonical, { name: node.name, version: node.version })
  }
  return `${node.name}@npm:${node.version}`
}

function edgeBlockOfKinds(
  graph: Graph,
  node: Node,
  kinds: readonly EdgeKind[],
  config: YarnBerryFamilyConfig,
  options: { skipMissingRange?: boolean } = {},
): SymlMap | undefined {
  const edges = kinds.flatMap(kind => graph.out(node.id, kind))
  if (edges.length === 0) return undefined

  const blockEntries: Array<[string, string]> = []
  // depName -> dst. When several kinds fold into one block, the only realistic
  // collision is the SAME target reached as both a `dep` and an `optional` edge
  // — berry lists it ONCE in `dependencies` (flagged optional via
  // dependenciesMeta), so the second kind collapses onto the first. A collision
  // on a DIFFERENT target is a genuine emit conflict (two packages claiming one
  // key) and still throws.
  const seen = new Map<string, string>()   // depName -> dst NodeId (string)

  for (const edge of edges) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) {
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: `edge from ${node.id} points to missing node ${edge.dst}`,
      })
    }
    if (edge.attrs?.range === undefined) {
      if (options.skipMissingRange) {
        continue
      }
      throw new LockfileError({
        code: 'MISSING_REQUIRED_FIELD',
        message: `edge ${node.id} -> ${edge.dst} (${edge.kind}) requires attrs.range for emit`,
      })
    }

    // Aliased descriptors emit under the alias key (the original parent-
    // manifest key); the value stays a full `npm:<dst>@<range>` locator
    // so reparse can resolve back to the same target via specIndex.
    // Canonical descriptors emit under the dst's actual name.
    const aliased = edge.attrs.alias !== undefined
    const depName = aliased ? edge.attrs.alias! : dst.name
    const prior = seen.get(depName)
    if (prior !== undefined) {
      if (prior === edge.dst) continue   // same target via another kind (dep+optional) → one entry
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: `cannot emit duplicate dependency key ${depName} from ${node.id} (targets ${prior} and ${edge.dst})`,
      })
    }
    seen.set(depName, edge.dst)
    blockEntries.push([depName, emittedRangeOfEdge(edge.kind, edge.attrs.range, config, aliased)])
  }

  if (blockEntries.length === 0) return undefined
  blockEntries.sort((a, b) => cmpStr(a[0]!, b[0]!))

  const block: SymlMap = {}
  for (const [name, range] of blockEntries) {
    block[name] = range
  }
  return block
}

// F8/#103 — fold the verbatim Rung-4-dropped refs into a (possibly undefined)
// live-edge block, re-emitting them byte-for-byte. Returns the merged SymlMap, or
// `undefined` when both inputs are empty (so the block is omitted exactly as
// before). A live edge ALWAYS wins a name collision (a resolvable dep was never
// dropped, so this is defensive only — it guarantees we never duplicate a key
// nor let a stale verbatim range shadow the live edge). Keys are re-sorted so the
// merged block keeps yarn's alphabetical inner-block order regardless of which
// source each entry came from.
function withUnresolvedDepRefs(
  liveBlock: SymlMap | undefined,
  refs: readonly UnresolvedDepRef[],
): SymlMap | undefined {
  if (refs.length === 0) return liveBlock
  const merged: SymlMap = {}
  if (liveBlock !== undefined) {
    for (const [name, range] of Object.entries(liveBlock)) merged[name] = range
  }
  for (const ref of refs) {
    if (!(ref.name in merged)) merged[ref.name] = ref.range
  }
  if (Object.keys(merged).length === 0) return undefined
  const sorted: SymlMap = {}
  for (const name of Object.keys(merged).sort(cmpStr)) sorted[name] = merged[name]!
  return sorted
}

function emittedRangeOfEdge(kind: EdgeKind, range: string, config: YarnBerryFamilyConfig, aliased: boolean = false): string {
  if (kind === 'peer') return range
  // Aliased edges encode `npm:<target>@<range>` as their range value —
  // the npm: prefix is structural (it carries the alias-target name), not
  // a bare-form decoration, so the bare-emit shortener does NOT strip it.
  if (aliased) return range
  // Synthesise the default `npm:` protocol for a bare semver range. A parsed
  // edge keeps its `npm:` verbatim, but a freshly-added edge (completion /
  // replaceVersion-refresh) carries the packument's BARE range; emitted bare,
  // yarn reads it as the `semver:` protocol ("isn't supported by any available
  // resolver") and `yarn install` aborts. `entryKeyRangeOf` adds `npm:` only to
  // a prefix-less semver — explicit protocols / GitHub shorthands stay verbatim,
  // and an already-`npm:` range is identity, so round-trip byte-fidelity holds.
  // (yaf lockgraph-message, 2026-06-20.)
  if (config.rangeEmit !== 'bare') return entryKeyRangeOf(range)
  return range.startsWith('npm:') ? range.slice('npm:'.length) : range
}

// Yarn-berry v8/v9 era default cacheKey. Used only when neither
// `options.cacheKey` nor a sidecar-derived value is available — typically
// when a mutated Graph (sidecar absent post-`mutate()`) gets stringified.
// Independent of `__metadata.cacheKey` emission: this default is for the
// integrity-translation slot only and does NOT cause `__metadata.cacheKey`
// to be written out (that path stays nullable per the "omits unless
// requested" contract).
const DEFAULT_CACHEKEY_V8_V9 = '10c0'

function checksumOfPayload(
  payload: TarballPayload | undefined,
  config: YarnBerryFamilyConfig,
  cacheKey: string | undefined,
  nodeId: string,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): string | undefined {
  const integrity = payload?.integrity
  if (integrity === undefined) return undefined

  // Berry `checksum` is a digest of yarn's zip-cache. ONLY a `berry-zip`-origin
  // sha512 may fill it; a tarball sha512 (npm/pnpm/bun/yarn-classic) is a
  // different artefact and MUST NOT be re-encoded here (yarn rejects it on
  // install). With no berry-zip digest the checksum line is OMITTED and
  // RECIPE_INTEGRITY_INCOMPLETE is emitted; yarn recomputes the digest on install.
  const hex = emitBerryChecksum(integrity)
  if (hex === undefined) {
    emitIntegrityIncomplete(
      nodeId,
      config.codePrefix,
      'source carries no yarn zip-cache (berry-zip) digest',
      emitDiagnostic,
    )
    return undefined
  }
  // Precedence (ADR-0031 round-trip):
  //   1. A per-node cacheKey captured at parse (`payload.berryChecksumCacheKey`)
  //      is reproduced verbatim for EVERY generation — this is what keeps a
  //      yarn-2.0 v4 `2/<hex>` round-tripping (v4 has checksumPrefix=false yet
  //      a parsed prefix must survive) AND v8/v9 `10c0/<hex>` byte-faithful.
  //   2. With no captured key but a prefix-era config (v8/v9/v10), fall back to
  //      the global cacheKey (`__metadata.cacheKey` / options / default) — the
  //      cross-family-convert and post-`mutate()` paths where the per-node
  //      sidecar was never set.
  //   3. Otherwise (bare-era v4/v5/v6/v7, no captured key) emit bare hex.
  const perNodeCacheKey = payload?.berryChecksumCacheKey
  if (perNodeCacheKey !== undefined) return `${perNodeCacheKey}/${hex}`
  return config.checksumPrefix ? `${cacheKey ?? DEFAULT_CACHEKEY_V8_V9}/${hex}` : hex
}

function extraBlockOfNode(node: Node, field: string): SymlMap | undefined {
  return coerceSymlMap((node as unknown as Record<string, unknown>)[field])
}

// Scalar `conditions` node-field hint (hand-built test nodes / cross-format
// stamping). `conditions:` is a SCALAR in yarn-berry, so only a string value is
// honoured; an object value is ignored (the corrected model — ADR-0018 §A.v5).
function scalarConditionsHintOfNode(node: Node): string | undefined {
  const raw = (node as unknown as Record<string, unknown>)['conditions']
  return typeof raw === 'string' ? raw : undefined
}

// Compose the yarn-berry `conditions:` SCALAR from a node's STRUCTURED platform
// constraints (`os`/`cpu`/`libc` on the TarballPayload) — the only source for a
// COMPLETION-added platform-optional package (`@napi-rs/nice-*`, `@esbuild/*`,
// `@rollup/rollup-*`, `@swc/*`, lightningcss, …). Such a node carries os/cpu/libc
// from its packument but has NEITHER a parse-captured `conditions` sidecar NOR a
// pre-composed node-field scalar, so without this yarn re-ADDS `conditions:` on
// `install --immutable` (YN0028 — the pijma/napi-rs break). Faithful port of
// `@yarnpkg/core` Manifest.getConditions: axes in FIXED order os → cpu → libc, a
// single value is bare (`os=darwin`), multiple are OR-grouped in parens
// (`(os=linux | os=android)`), present axes `&`-joined. Verified byte-identical to
// the real-world corpus on the single-value case (`os=darwin & cpu=arm64`,
// `os=linux & cpu=x64 & libc=musl`).
// Faithful port of yarn's `toConditionToken` (@yarnpkg/core Manifest): a value's
// LEADING `!` run migrates to a prefix BEFORE the axis name — `!win32` → `!os=win32`,
// NOT `os=!win32` — and an EVEN-length run cancels (`!!win32` → `os=win32`). Getting
// this wrong is itself a YN0028: yarn recomputes the canonical token on `install
// --immutable`, sees `os=!win32` ≠ its `!os=win32`, and rewrites. Real trigger:
// `eiows` publishes `os: ["!win32"]`. Verbatim slice math (incl. the JS `search`
// returning -1 for an all-`!` value) mirrors yarn byte-for-byte.
export function conditionToken(name: string, raw: string): string {
  const index = raw.search(/[^!]/)
  const prefix = index % 2 === 0 ? '' : '!'
  const value = raw.slice(index)
  return `${prefix}${name}=${value}`
}

export function composeConditionsFromPayload(payload: TarballPayload | undefined): string | undefined {
  if (payload === undefined) return undefined
  const parts: string[] = []
  const push = (name: string, values: string[] | undefined): void => {
    if (values === undefined || values.length === 0) return
    const tokens = values.map(v => conditionToken(name, v))
    parts.push(tokens.length === 1 ? tokens[0]! : `(${tokens.join(' | ')})`)
  }
  push('os', payload.os)
  push('cpu', payload.cpu)
  push('libc', payload.libc)
  return parts.length > 0 ? parts.join(' & ') : undefined
}

/**
 * Re-derive the `peerDependenciesMeta` block (task #86, extended by #89). Mirrors
 * the pnpm reference emitter (`_pnpm-flat-core.ts` `entryOfNode`): scan
 * out-`peer`-edges for `attrs.optional === true` and emit `<peer>: { optional:
 * true }`, UNIONED with the verbatim hint. The hint has two sources, both routed
 * through THIS single emit site (so there is no parallel emit path):
 *   - the per-node raw SIDECAR captured at parse from a real berry lock
 *     (`rawPeerDependenciesMetaBlockOfNode`) — task #89 berry→berry round-trip;
 *   - the `extraBlockOfNode` node field — same-format hand-built test nodes and
 *     cross-format manifests that stamp the block directly onto the Node.
 *
 * The edge signal alone is incomplete — an optional peer the source PM never
 * resolved has no peer-virt instance and hence no edge — so the hint carries
 * what the edge set cannot. Conversely the sidecar alone misses peer-optionals
 * that only an edge (post-enrich / cross-format) knows; unioning both keeps
 * berry→berry and pnpm→berry on one path. Peer-block keys are alias-aware (the
 * edge `alias`, else `dst.name`) so the meta key matches the emitted
 * `peerDependencies` key. A `Set` of names dedupes, so a peer that is optional
 * in BOTH the edge and the hint is emitted exactly once (no double-emit).
 */
function peerDependenciesMetaOfNode(graph: Graph, node: Node, payload: TarballPayload | undefined): SymlMap | undefined {
  const optionalPeers = new Set<string>()
  for (const edge of graph.out(node.id, 'peer')) {
    if (edge.attrs?.optional !== true) continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    optionalPeers.add(edge.attrs.alias ?? dst.name)
  }

  // Verbatim hint: sidecar (real-lock round-trip) preferred over the node field,
  // then the payload block a COMPLETION-added node carries (a minted node has no
  // sidecar/edges — the payload is its only peer-meta source).
  // Carried through to emit so any NON-`optional` key yarn might write (today it
  // only writes `optional`) survives unmodelled, per task #89's preserve-via-
  // sidecar requirement.
  const hint = rawPeerDependenciesMetaBlockOfNode(graph, node.id)
    ?? extraBlockOfNode(node, 'peerDependenciesMeta')
    ?? coerceSymlMap(payload?.peerDependenciesMeta)
  if (hint !== undefined) {
    for (const [peerName, m] of Object.entries(hint)) {
      if (isOptionalMetaEntry(m)) optionalPeers.add(peerName)
    }
  }

  if (optionalPeers.size === 0) return hint
  // Start from the verbatim hint (preserving any extra keys), then ensure every
  // edge/hint-derived optional peer carries `optional: true`.
  const block: SymlMap = hint !== undefined ? { ...coerceSymlMap(hint) } : {}
  for (const peerName of Array.from(optionalPeers).sort(cmpStr)) {
    const existing = coerceSymlMap(block[peerName]) ?? {}
    block[peerName] = { ...existing, optional: 'true' }
  }
  // Re-sort keys so emit order is deterministic regardless of hint key order.
  const sorted: SymlMap = {}
  for (const peerName of Object.keys(block).sort(cmpStr)) sorted[peerName] = block[peerName]!
  return sorted
}

function isOptionalMetaEntry(value: SymlValue): boolean {
  if (!value || typeof value !== 'object') return false
  // `coerceSymlMap` already stringifies a manifest's boolean `true` to `'true'`,
  // so the hint's `optional` flag is always a string by the time it reaches us.
  return (value as Record<string, SymlValue>)['optional'] === 'true'
}

function coerceSymlMap(value: unknown): SymlMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const raw = value as Record<string, unknown>
  const block: SymlMap = {}
  for (const key of Object.keys(raw).sort(cmpStr)) {
    const coerced = coerceSymlValue(raw[key])
    if (coerced !== undefined) {
      block[key] = coerced
    }
  }

  return Object.keys(block).length > 0 ? block : undefined
}

function coerceSymlValue(value: unknown): SymlValue | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return coerceSymlMap(value)
}

function cloneSymlValue(value: SymlValue | undefined): SymlValue | undefined {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  return coerceSymlMap(value)
}

export function binBlockOfNode(node: Node, payload: TarballPayload | undefined): SymlMap | undefined {
  if (payload?.bin === undefined) return undefined
  if (typeof payload.bin === 'string') {
    // npm: a STRING `bin` declares ONE command whose name is the package's
    // UNSCOPED name (`@babel/parser` → `parser`), not the full id. Keying it by
    // `node.name` emits `"@babel/parser": …`, which `yarn install --immutable`
    // rewrites to `parser: …` (seen when completion adds a scoped string-bin pkg).
    const cmd = node.name.startsWith('@') ? node.name.slice(node.name.indexOf('/') + 1) : node.name
    return { [cmd]: payload.bin }
  }

  const block: SymlMap = {}
  for (const name of Object.keys(payload.bin).sort(cmpStr)) {
    const target = payload.bin[name]
    if (target !== undefined) block[name] = target
  }
  return Object.keys(block).length > 0 ? block : undefined
}

function extractPatchFingerprint(
  nodeId: string,
  resolution: string,
  workspaceRoot: string | undefined,
): { patch: string; diagnostic?: Diagnostic } | undefined {
  const locator = patchLocatorOfResolution(resolution)
  if (locator === undefined) return undefined

  const source = patchSourceOfLocator(locator)
  if (source === undefined) {
    return unresolvedPatch(nodeId, locator, 'patch locator has no source fragment')
  }

  if (source.startsWith('~builtin<')) {
    const yarnMajor = yarnMajorOfBuiltinPatch(resolution)
    if (yarnMajor === undefined) {
      return unresolvedPatch(nodeId, locator, 'builtin patch yarn-major is unavailable at parse time')
    }
    // Builtin patches hash a synthetic string (no on-disk source); F5 byte
    // normalisation is inapplicable.
    return { patch: sha512Hex(`${yarnMajor}:${source}`) }
  }

  if (workspaceRoot === undefined) {
    return unresolvedPatch(nodeId, locator, 'workspaceRoot is unavailable at parse time')
  }

  const bytes = readWorkspaceFileBytes(workspaceRoot, source, locator)
  if (bytes === undefined) {
    return unresolvedPatch(nodeId, locator, 'patch file is unavailable at parse time')
  }

  // ADR-0014 §4.F5 — apply CRLF / BOM byte normalisation BEFORE the F2
  // sha512 fingerprint; emit `RECIPE_PATCH_NORMALISED` (info) when ≥ 1
  // byte changed so cross-platform CRLF rewrites surface in diagnostics.
  // Combined helper avoids a second F5 scan inside canonicalHashOfBytes.
  const { hash: patch, normalised: didNormalise } = patchHashAndNormaliseBytes(bytes)
  return didNormalise
    ? { patch, diagnostic: patchNormalisedDiagnostic(nodeId) }
    : { patch }
}

export function patchLocatorOfResolution(resolution: string): string | undefined {
  if (resolution.startsWith('patch:')) return resolution
  const idx = resolution.indexOf('@patch:')
  return idx >= 0 ? resolution.slice(idx + 1) : undefined
}

export function patchSourceOfLocator(locator: string): string | undefined {
  const hashIdx = locator.indexOf('#')
  if (hashIdx < 0) return undefined
  const paramsIdx = locator.indexOf('::', hashIdx + 1)
  const source = paramsIdx < 0
    ? locator.slice(hashIdx + 1)
    : locator.slice(hashIdx + 1, paramsIdx)
  return isDegeneratePatchSource(source) ? undefined : source
}

export function isDegeneratePatchSource(source: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(source)
  } catch {
    return false
  }

  const trimmed = decoded.trim()
  if (trimmed === '') return true
  if (path.posix.isAbsolute(trimmed)) return false

  const segments = path.posix.normalize(trimmed).split('/').filter(segment => segment !== '' && segment !== '.')
  return segments.length === 0
}

function yarnMajorOfBuiltinPatch(_resolution: string): string | undefined {
  return undefined
}

function unresolvedPatch(nodeId: string, locator: string, reason: string): { patch: string; diagnostic: Diagnostic } {
  return {
    patch: sentinelHashOfLocator(locator),
    diagnostic: {
      code: 'YARN_BERRY_PATCH_UNRESOLVED',
      subject: nodeId,
      severity: 'warning',
      message: `${reason}; using sentinel for ${locator}`,
    },
  }
}

function sha512Hex(value: string | Uint8Array): string {
  return createHash('sha512').update(value).digest('hex')
}

// Compose a tailored IRREDUCIBLE_LOSS hint for the parse-time NodeId
// collision case. Scans the previously-seen entry list for the colliding
// entry to surface BOTH `resolution:` strings — so callers can tell at a
// glance whether they hit (a) an npm: alias, (b) a `patch:` collision,
// (c) a `link:` / `portal:` locator collision (workspace-link variant).
// The hint is best-effort: when the prior entry can't be matched by raw
// key (compound entry-keys split by `, `), we fall back to the legacy
// generic hint that names all three known causes.
export function irreducibleCollisionMessage(
  id: string,
  currentKey: string,
  priorEntries: ReadonlyArray<{ key: string; value: SymlMap; specs: SpecPart[] }>,
): string {
  const currentEntry = priorEntries.find(e => e.key === currentKey)
  const currentResolution = currentEntry !== undefined ? asString(currentEntry.value['resolution']) : undefined

  // The prior entry that landed on `id`: scan the list from the start; the
  // collision is by definition between the current entry and the FIRST
  // prior entry that derived the same NodeId. Without re-deriving NodeIds
  // here we approximate by name+version match.
  const currentFirst = currentEntry?.specs[0]
  const priorEntry = currentEntry === undefined ? undefined : priorEntries.find(e => {
    if (e.key === currentKey) return false
    const otherFirst = e.specs[0]
    if (otherFirst === undefined || currentFirst === undefined) return false
    if (otherFirst.name !== currentFirst.name) return false
    return asString(e.value['version']) === asString(currentEntry.value['version'])
  })
  const priorResolution = priorEntry !== undefined ? asString(priorEntry.value['resolution']) : undefined

  const isLink = (r: string | undefined): boolean =>
    r !== undefined && (r.includes('@link:') || r.includes('@portal:'))
  const isPatch = (r: string | undefined): boolean =>
    r !== undefined && r.includes('@patch:')
  const isBind = (r: string | undefined): boolean =>
    r !== undefined && r.includes('::')

  let hint = 'likely npm: alias, patch: collision, workspace link: locator collision, or a `::` bind modifier (`::__archiveUrl=` / `::version=` / `::hash=`)'
  if (isLink(currentResolution) || isLink(priorResolution)) {
    hint = 'likely workspace link: / portal: locator collision (yarn `::locator=` qualifier was lost)'
  } else if (isPatch(currentResolution) || isPatch(priorResolution)) {
    hint = 'likely patch: collision'
  } else if (isBind(currentResolution) || isBind(priorResolution)) {
    hint = 'likely a `::` bind modifier collision (`::__archiveUrl=` private-registry mirror, `::version=`, or `::hash=` — the bind was lost from the NodeId)'
  }

  const resolutions = [priorResolution, currentResolution].filter((r): r is string => typeof r === 'string')
  const tail = resolutions.length > 0 ? ` — resolutions: [${resolutions.map(r => JSON.stringify(r)).join(', ')}]` : ''
  return `two entries collapse onto NodeId ${id} — ${hint}${tail}`
}

function stringRecordOfBlock(block: SymlMap | undefined): Record<string, string> | undefined {
  if (!block) return undefined

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(block)) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function sortPeerContext(peers: readonly string[]): string[] {
  return peers.slice().sort((a, b) => {
    const nameCmp = cmpStr(nameOf(a), nameOf(b))
    return nameCmp !== 0 ? nameCmp : cmpStr(a, b)
  })
}

function deriveFinalNodeIds(graph: Graph, derivedPeersByNodeId: Map<string, DerivedPeer[]>): Map<string, string> {
  const finalIds = new Map<string, string>()
  const nodes = Array.from(graph.nodes())
  for (const node of nodes) {
    finalIds.set(node.id, node.id)
  }

  for (let i = 0; i < nodes.length; i++) {
    let changed = false
    for (const node of nodes) {
      const derivedPeers = derivedPeersByNodeId.get(node.id)
      if (derivedPeers === undefined) continue

      const peerContext = sortPeerContext(derivedPeers.map(peer => finalIds.get(peer.dstOldId) ?? peer.dstOldId))
      const nextId = serializeNodeId(node.name, node.version, peerContext, node.patch, node.source)
      if (finalIds.get(node.id) !== nextId) {
        finalIds.set(node.id, nextId)
        changed = true
      }
    }
    if (!changed) return finalIds
  }

  throw new LockfileError({
    code: 'INVARIANT_VIOLATION',
    message: 'peer enrichment did not converge',
  })
}

function isDerivedWorkspaceRange(range: string | undefined): boolean {
  return typeof range === 'string' && range.startsWith('workspace:')
}

/**
 * F4 yarn-berry attribution rule (ADR-0014 §4.F4): given an eligible
 * source edge + workspace-member destination, derive the `{ workspace:
 * true, workspaceRange }` attrs payload. yarn-berry takes the verbatim
 * `workspace:<spec>` range from disk as the source-side specifier;
 * `resolvedVersion` is best-effort `dst.version` (`0.0.0-use.local`
 * sentinel when manifests are absent). Single source of truth shared
 * by parse-time `markWorkspaceEdgesAtParse` AND enrich-time rewiring
 * — the rule is yarn-berry-specific (other adapters carry different
 * workspace shapes) so it stays local rather than living in `recipe/`.
 */
function deriveMarkedWorkspaceAttrs(attrs: EdgeAttrs | undefined, dst: Node): EdgeAttrs {
  const rawSpecifier = attrs?.range ?? ''
  const workspaceRange = dst.version !== undefined && dst.version !== ''
    ? { specifier: rawSpecifier, resolvedVersion: dst.version }
    : { specifier: rawSpecifier }
  return { ...attrs, workspace: true, workspaceRange }
}

/**
 * Post-seal mutation: mark `workspace: true` on every edge whose range
 * carries the `workspace:` protocol AND whose target is a workspace
 * member; populate the canonical `attrs.workspaceRange` sidecar per
 * ADR-0014 §4.F4. Called from parseFamily so the public parse() surface
 * delivers F4-ready edges without requiring an explicit enrich step.
 */
function markWorkspaceEdgesAtParse(graph: Graph): Graph {
  const edgesToMark: Array<{ src: string; dst: string; kind: EdgeKind; attrs: EdgeAttrs }> = []
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      if (!isDerivedWorkspaceRange(edge.attrs?.range)) continue
      const dst = graph.getNode(edge.dst)
      if (dst?.workspacePath === undefined) continue
      edgesToMark.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: deriveMarkedWorkspaceAttrs(edge.attrs, dst),
      })
    }
  }
  if (edgesToMark.length === 0) return graph
  return graph.mutate(m => {
    for (const e of edgesToMark) {
      m.removeEdge(e.src, e.dst, e.kind)
      m.addEdge(e.src, e.dst, e.kind, e.attrs)
    }
  }).graph
}

function ambiguousPeerMessage(peerName: string, candidates: readonly string[]): string {
  return `peer "${peerName}" matches multiple installed versions: [${candidates.join(', ')}]`
}

// === peerDependenciesMeta fill ladder (task #86) ============================

interface PeerMetaContext {
  workspaceRoot?: string
  resolver?: (parentName: string, parentVersion: string, peerName: string) => boolean | undefined
  // True when at least one EXTERNAL rung (rung-2 local manifest or rung-3/4
  // resolver) is configured. Drives whether an unresolved peer is reported:
  // in pure rung-1 mode the graph is the sole authority, "no optional flag"
  // means "not optional", and we stay silent (no fabrication, no warning
  // noise for every genuinely-required peer). RECIPE_PEER_META_INCOMPLETE
  // fires only when an external lookup was requested yet could not answer.
  hasExternalRung: boolean
  // Memoise installed-manifest reads per parent `name version` so a
  // package referenced by many consumers triggers one fs read; `null` =
  // looked up, not on disk (distinct from "not yet looked up").
  manifestCache: Map<string, InstalledManifestMeta | null>
}

function peerEdgeKey(src: string, dst: string): string {
  return `${src} ${dst}`
}

// Rung-0 (task #89): is `peerName` marked optional in the node's VERBATIM
// `peerDependenciesMeta` sidecar captured from a real berry lock? Authoritative
// on-lock signal — no external lookup. Keys are the peer's descriptor name
// (alias-aware on emit), matched here against the resolved peer name.
//
// Key-name nuance: the enrich call site passes the RESOLVED peer's `dst.name`,
// whereas yarn keys `peerDependenciesMeta` by the parent manifest's DESCRIPTOR
// name. These diverge only for an npm-ALIASED peer (descriptor key != resolved
// package name). That case is unreachable via the berry PARSE path — a berry
// peer edge carries no `alias` (peer ranges are bare, never `npm:<target>@…`),
// so `dst.name` always equals the descriptor key here — and even if it ever
// could, the verbatim sidecar preserves the whole `peerDependenciesMeta` block
// byte-faithfully on emit regardless of this lookup. Revisit if peer-aliasing is
// ever modelled (the lookup would then need the descriptor key, not `dst.name`).
function berryMetaPeerOptional(graph: Graph, nodeId: string, peerName: string): boolean {
  const block = sidecarByGraph.get(graph)?.peerDependenciesMeta?.get(nodeId)
  const entry = block?.[peerName]
  return entry !== undefined && isOptionalMetaEntry(entry)
}

function createPeerMetaContext(options: YarnBerryFamilyEnrichOptions): PeerMetaContext {
  return {
    workspaceRoot:   options.workspaceRoot,
    resolver:        options.peerMetaResolver,
    hasExternalRung: options.workspaceRoot !== undefined || options.peerMetaResolver !== undefined,
    manifestCache:   new Map(),
  }
}

/**
 * Resolve whether `peerName` is an OPTIONAL peer of `parent`, walking the fill
 * ladder. Returns `true` when an authoritative source marks it optional,
 * `false` when an authoritative source proves it required, and `undefined`
 * when no rung can answer (the caller then leaves the edge untouched). On an
 * unanswerable lookup with an external rung configured, pushes
 * RECIPE_PEER_META_INCOMPLETE onto `diagnostics`.
 */
function resolvePeerOptional(
  graph: Graph,
  ctx: PeerMetaContext,
  parent: Node,
  peerName: string,
  diagnostics: PendingDiagnostic[],
): boolean | undefined {
  // Rung-2 — installed parent manifest under `<workspaceRoot>/node_modules`.
  if (ctx.workspaceRoot !== undefined) {
    const manifest = readParentManifest(ctx, parent)
    if (manifest !== null) {
      // The manifest is authoritative: peerDependenciesMeta lists ONLY the
      // optional peers, so a present+optional entry → true, and any other
      // outcome (entry absent, or present without `optional:true`) → required.
      return manifest.peerDependenciesMeta?.[peerName]?.optional === true
    }
  }

  // Rung-3/4 — opt-in caller resolver (cache / pre-fetched registry). Sync by
  // contract so `enrich` never opens a socket itself.
  if (ctx.resolver !== undefined) {
    const fromResolver = ctx.resolver(parent.name, parent.version, peerName)
    if (fromResolver !== undefined) return fromResolver
  }

  if (ctx.hasExternalRung) {
    diagnostics.push({
      ...recipePeerMetaIncomplete(
        parent.id,
        peerName,
        ctx.workspaceRoot !== undefined
          ? 'parent manifest not found in node_modules and no resolver answered'
          : 'no resolver answered',
      ),
      subject: parent.id,
    })
  }
  // Pure rung-1 mode (no external rung) returns undefined silently.
  void graph
  return undefined
}

function readParentManifest(ctx: PeerMetaContext, parent: Node): InstalledManifestMeta | null {
  const key = `${parent.name} ${parent.version}`
  const cached = ctx.manifestCache.get(key)
  if (cached !== undefined) return cached
  const manifest = ctx.workspaceRoot === undefined
    ? null
    : readInstalledManifest(ctx.workspaceRoot, parent.name, parent.id) ?? null
  ctx.manifestCache.set(key, manifest)
  return manifest
}

function finalizePendingDiagnostic(diagnostic: PendingDiagnostic, nextNodes: Map<string, Node>): Diagnostic {
  const subject = nextNodes.get(diagnostic.subject)?.id ?? diagnostic.subject
  const message = diagnostic.code.endsWith('_PEER_AMBIGUOUS')
    && diagnostic.peerName !== undefined
    && diagnostic.candidateIds !== undefined
    ? ambiguousPeerMessage(
      diagnostic.peerName,
      diagnostic.candidateIds.map(candidateId => nextNodes.get(candidateId)?.id ?? candidateId),
    )
    : diagnostic.message

  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    subject,
    message,
  }
}

function graphNeedsWorkspaceAttribution(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      if (!isDerivedWorkspaceRange(edge.attrs?.range)) continue
      if (graph.getNode(edge.dst)?.workspacePath !== undefined) return true
    }
  }
  return false
}

// Rung 1 — patch-descriptor (#88) + link/portal `::locator=` (#90) fallbacks.
// Extracted so the override-`to` re-resolution (Rung 2) can reuse the SAME
// structural rungs: a `to:"patch:…"` target resolves to its patch node exactly
// as a direct `patch:` descriptor does. Returns the resolved node id, `null`
// (ambiguous patch descriptor — diagnostic already pushed, caller must skip the
// edge), or `undefined` (no Rung-1 match — caller falls to Rung 2/3).
function resolvePatchAndLinkFallbacks(
  lookup: string,
  normalizedRange: string,
  index: Map<string, string>,
  patchDescriptorIndex: Map<string, PatchDescriptorCandidate[]>,
  srcResolution: string | undefined,
  srcId: string,
  diagnostics: Diagnostic[],
): string | undefined | null {
  if (isPatchRange(normalizedRange)) {
    // Bug #88 (form b) — the dep is referenced DIRECTLY via a `patch:`
    // descriptor (`<name>@patch:<inner>#<patchPath>`). The bound patch entry
    // carries an extra `::version=…&hash=…[&locator=…]` block its consumers
    // omit, so the bare descriptor never hit `specIndex`. Strip the param block
    // off the descriptor and resolve to the patch NODE keyed under it.
    const stripped = strippedPatchDescriptor(lookup)
    if (stripped !== undefined) {
      return resolvePatchDescriptor(patchDescriptorIndex.get(stripped), srcResolution, srcId, lookup, diagnostics)
    }
  }
  if (srcResolution !== undefined && isLinkOrPortalRange(normalizedRange)) {
    // `link:` / `portal:` deps are recorded per consumer: yarn appends a
    // `::locator=<encoded-consumer-locator>` qualifier to the entry key so the
    // same on-disk path linked from different workspaces stays distinct. The
    // deps-block descriptor is bare (no qualifier), so reconstruct the
    // locator-qualified specIndex key from the source consumer's own resolution.
    // encodeURIComponent matches yarn's entry-key encoding (`@`->%40, `:`->%3A,
    // `/`->%2F), e.g. `pkg@workspace:.` -> `pkg%40workspace%3A.`.
    const qualified = `${lookup}::locator=${encodeURIComponent(srcResolution)}`
    return index.get(qualified)
  }
  return undefined
}

// A descriptor range is a registry range (`npm:`/bare) — the only class Rung-3
// semver and the resolutions-pin INFO hint apply to. Any explicit non-`npm:`
// protocol (`patch:`, `link:`, `portal:`, `file:`, `git…`, a URL scheme) is out.
export function isRegistryRange(range: string): boolean {
  if (range.startsWith('npm:')) return true
  return !hasExplicitProtocol(range)
}

// Bug #99 — the descriptor→node ladder's Rung-2/3 inputs (see
// spec/formats/_common.md §"Descriptor→node resolution"). Bundled so the
// steady-state Rung-0 exact-match path stays a single `index.get`.
interface EdgeLadderContext {
  /** name → registry-class candidates for Rung-3 max-satisfying semver. */
  candidatesByName: Map<string, SemverCandidate[]>
  /** `name@version` → sibling registry-base patch nodes for the Bug #104
   *  Rung-3 patch-preference OVERLAY (`[]`/absent = none). */
  patchSiblingsByBase: Map<string, PatchSibling[]>
  /** canonical override constraints for Rung-2 forced links (`[]` = none). */
  overrides: readonly OverrideConstraint[]
  /** adapter code prefix for the ladder diagnostics (e.g. `YARN_BERRY_V8`). */
  codePrefix: string
  /** whether `ParseOptions.manifests` was supplied — gates the manifest-less
   *  INFO hint when a likely resolutions-pin can't be bridged. */
  manifestsProvided: boolean
}

// berry folds optional deps into `dependencies`, flagged by
// `dependenciesMeta.<name>.optional: true` (it has no optionalDependencies
// block). Partition a dependencies block by that flag so the flagged entries
// become `optional` edges and the rest `dep`. The flag is read from the
// verbatim per-node dependenciesMeta sidecar (a bare boolean captured as the
// string 'true'). Other meta keys (built / unplugged) do NOT reclassify.
export function splitOptionalDeps(
  deps: SymlMap | undefined,
  meta: SymlMap | undefined,
): { regular: SymlMap | undefined; optional: SymlMap | undefined } {
  if (deps === undefined) return { regular: undefined, optional: undefined }
  if (meta === undefined) return { regular: deps, optional: undefined }
  let regular:  SymlMap | undefined
  let optional: SymlMap | undefined
  for (const [name, range] of Object.entries(deps)) {
    if (isOptionalDepFlag(meta, name)) (optional ??= {})[name] = range
    else                               (regular  ??= {})[name] = range
  }
  return { regular, optional }
}

function isOptionalDepFlag(meta: SymlMap, name: string): boolean {
  const entry = meta[name]
  if (entry === undefined || typeof entry === 'string') return false
  return (entry as Record<string, SymlValue>)['optional'] === 'true'
}

function addEdgesFromBlock(
  builder: ReturnType<typeof newBuilder>,
  srcId: string,
  block: SymlMap | undefined,
  kind: EdgeKind,
  index: Map<string, string>,
  patchDescriptorIndex: Map<string, PatchDescriptorCandidate[]>,
  diagnostics: Diagnostic[],
  ladder: EdgeLadderContext,
  srcResolution?: string,
  // F8/#103 — collector for Rung-4-dropped refs whose target is absent from the
  // lock. Appended to (keyed by srcId) so emit can re-emit them verbatim into the
  // matching inner-block; omitted (undefined) on paths that don't preserve.
  unresolvedDeps?: Map<string, UnresolvedDepRef[]>,
): void {
  if (!block) return
  for (const [depName, depRange] of Object.entries(block)) {
    if (typeof depRange !== 'string') continue
    const normalizedRange = normalizedEdgeRange(kind, depRange)
    const lookup = `${depName}@${normalizedRange}`
    // `null` ⇒ resolution was attempted and deliberately abandoned (ambiguous
    // patch descriptor, diagnostic already emitted) — distinct from `undefined`
    // (not yet resolved), so the generic UNRESOLVED_DEP fallback is skipped.
    // Rung 0 — exact specIndex match (UNCHANGED, first, O(1)).
    let dstId: string | undefined | null = index.get(lookup)
    // Bug #104 — track whether Rung 2 (override map) forced this bind, so the
    // patch-preference OVERLAY does NOT fire on top of an override redirect (the
    // override already points at whatever node the human declared, patch or not).
    let boundViaOverride = false
    // Rung 1 — patch-descriptor (#88) + link/portal `::locator=` (#90)
    // fallbacks (UNCHANGED). Run on the Rung-0 MISS path only, before Rung 2/3,
    // so a more-specific structural match wins over the override/semver rungs.
    if (dstId === undefined) {
      dstId = resolvePatchAndLinkFallbacks(
        lookup, normalizedRange, index, patchDescriptorIndex, srcResolution, srcId, diagnostics,
      )
      if (dstId === null) continue // ambiguous patch descriptor → diagnostic pushed
    }
    // Rung 2 — OVERRIDE-MAP forced link. An authoritative human declaration
    // (`resolutions` / `overrides`) beats inference, so it precedes semver and
    // handles a NON-satisfying pin (csstype `^3.1.3` → `3.0.9`) or a non-version
    // target (`patch:` / `portal:`). The override `to` is fed BACK through Rung
    // 0+1 so `to:"3.0.9"` → the exact node and `to:"patch:…"` → the patch node.
    // Risk (e): an override `to` that fails Rung 0/1 falls through to Rung 3 on
    // the ORIGINAL descriptor below — never throws.
    if (dstId === undefined && ladder.overrides.length > 0) {
      const to = overrideTargetFor(depName, normalizedRange, [nameOf(srcId)], ladder.overrides)
      if (to !== undefined) {
        const toLookup = `${depName}@${entryKeyRangeOf(to)}`
        let viaOverride: string | undefined | null = index.get(toLookup)
        if (viaOverride === undefined) {
          viaOverride = resolvePatchAndLinkFallbacks(
            toLookup, entryKeyRangeOf(to), index, patchDescriptorIndex, srcResolution, srcId, diagnostics,
          )
          if (viaOverride === null) continue // ambiguous patch target → diagnostic pushed
        }
        if (viaOverride !== undefined) {
          dstId = viaOverride
          boundViaOverride = true
        }
      }
    }
    // Rung 3 — SOURCE-GATED max-satisfying semver. Only `npm:`/bare descriptors,
    // only tarball(registry)-class candidates (a git/directory/unknown node stays
    // invisible — the #91 source-safety). A final tie → diagnose + drop.
    if (dstId === undefined) {
      const result = semverResolve(normalizedRange, ladder.candidatesByName.get(depName) ?? [])
      if (result.kind === 'bound') {
        dstId = result.id
      } else if (result.kind === 'ambiguous') {
        diagnostics.push(ambiguousResolutionDiagnostic(ladder.codePrefix, srcId, depName, normalizedRange, result.candidateIds))
        continue // do not guess — mirror the *_PEER_AMBIGUOUS rule
      }
    }
    // Rung 3.5 — DIST-TAG bind (#107). A registry descriptor whose range is a
    // published dist-TAG (`latest` / `next`), not a semver range, binds the
    // UNIQUE registry sibling of that name (source-gated exactly like Rung 3). A
    // multi-version tag is genuine ambiguity → diagnose + drop (never guess a max
    // version: `latest`/`next` are channel pointers and `next` is often older).
    if (dstId === undefined) {
      const result = distTagResolve(normalizedRange, ladder.candidatesByName.get(depName) ?? [])
      if (result.kind === 'bound') {
        dstId = result.id
      } else if (result.kind === 'ambiguous') {
        diagnostics.push(ambiguousResolutionDiagnostic(ladder.codePrefix, srcId, depName, normalizedRange, result.candidateIds))
        // The manifest-less INFO hint also applies to a multi-version tag drop:
        // a `latest`/`next` against ≥2 siblings is the same "lock can't resolve
        // it; a manifest could" signature as a non-satisfying pin.
        if (!ladder.manifestsProvided) {
          diagnostics.push(resolutionPinUnresolvedDiagnostic(ladder.codePrefix, srcId, depName, normalizedRange))
        }
        continue // do not guess — mirror the *_PEER_AMBIGUOUS rule
      }
    }
    // Rung 3.6 — CATALOG bind (berry catalog: protocol). A `catalog:` /
    // `catalog:<name>` descriptor defers its range to a catalog defined OUTSIDE
    // the lockfile (.yarnrc.yml / pnpm-workspace.yaml / root package.json); the
    // lock already carries the resolved entry, so bind the UNIQUE registry
    // sibling of that name. Without this the descriptor never resolves to an edge
    // and the whole cataloged subtree looks orphaned to a downstream GC.
    //
    // ONLY the unique-sibling case binds. With ≥2 (or 0) siblings we cannot pick
    // without the external catalog map, so we FALL THROUGH to Rung 4 — which
    // preserves the `catalog:` descriptor VERBATIM (F8) and diagnoses. (Never
    // `continue` here: that would skip the Rung-4 verbatim preservation and drop
    // the descriptor from emit, breaking byte round-trip — babel has multiple
    // `@jridgewell/trace-mapping` / `semver` versions behind one `catalog:`.)
    if (dstId === undefined) {
      const result = catalogResolve(normalizedRange, ladder.candidatesByName.get(depName) ?? [])
      if (result.kind === 'bound') dstId = result.id
    }
    // Bug #104 Rung-3 OVERLAY — PATCH PREFERENCE (berry only). After a REGISTRY
    // range bound its BASE node via Rung 0 or 3 with NO override forcing it, yarn
    // redirects the consumer onto a sibling `patch:` copy of the same
    // `name@version` when the lock carries one (the `patchedDependencies` map
    // patches the package for every consumer). A single patch sibling redirects;
    // ≥2 bind only on a unique `::locator=` match against the consumer's own
    // resolution; no match keeps the base (no guess). WITH manifests the override
    // rung already performed the redirect (boundViaOverride) → skip (no double-
    // redirect). The base node is left GC-able (the patch re-emits from its own
    // locator; `optimize()` prunes the orphan) — matching yarn.
    if (typeof dstId === 'string' && !boundViaOverride && isRegistryRange(normalizedRange)) {
      const bound = nodeNameVersion(dstId)
      const siblings = bound === undefined ? undefined : ladder.patchSiblingsByBase.get(bound)
      if (siblings !== undefined && siblings.length > 0) {
        const consumerLocator = srcResolution !== undefined ? encodeURIComponent(srcResolution) : undefined
        const patchId = patchPreferenceFor(depName, normalizedRange, siblings, consumerLocator)
        if (patchId !== undefined && patchId !== dstId) {
          dstId = patchId
          diagnostics.push(patchPreferredDiagnostic(ladder.codePrefix, srcId, depName, normalizedRange, patchId))
        }
      }
    }
    if (!dstId) {
      // Rung 4 — drop (UNCHANGED). When a likely resolutions-pin missed both the
      // exact key and every semver candidate AND no manifests were supplied, add
      // an INFO hint pointing at the missing override source (the only place yarn
      // records a pin) so the non-satisfying-pin case is diagnosable.
      diagnostics.push({
        code: 'YARN_BERRY_UNRESOLVED_DEP',
        subject: srcId,
        severity: 'warning',
        message: `dependency ${depName}=${depRange} from ${srcId} has no matching lockfile entry`,
      })
      if (!ladder.manifestsProvided && isRegistryRange(normalizedRange) && (ladder.candidatesByName.get(depName)?.length ?? 0) > 0) {
        diagnostics.push(resolutionPinUnresolvedDiagnostic(ladder.codePrefix, srcId, depName, normalizedRange))
      }
      // F8/#103 — the dep target is ABSENT from the lock, so no graph edge can
      // bind it (we do NOT mint a phantom node — identity stays clean). Preserve
      // the descriptor VERBATIM (the on-disk block kind, dep-name, and exact range
      // string) in the per-node sidecar so a SAME-FORMAT round-trip re-emits this
      // line byte-for-byte. The diagnostic above still fires — preservation keeps
      // BOTH the bytes and the signal; it does not silence the MISSING-ENTRY warn.
      // `peer` never reaches here (peers round-trip via the peerDependencies raw
      // sidecar), so only the dep / optional emit blocks are addressed.
      if (unresolvedDeps !== undefined && (kind === 'dep' || kind === 'optional')) {
        const refs = unresolvedDeps.get(srcId) ?? []
        // berry folds BOTH regular and optional deps into the single
        // `dependencies` block, so an unresolvable optional ref re-emits there
        // too (its optional-ness rides the verbatim dependenciesMeta sidecar).
        refs.push({
          block: 'dependencies',
          name: depName,
          range: depRange,
        })
        unresolvedDeps.set(srcId, refs)
      }
      continue
    }
    // EdgeAttrs.alias — preserved when the parent's dependencies-block key
    // (`depName`) differs from the target's actual name. Yarn-berry encodes
    // npm-alias deps as `"<alias>": "npm:<target>@<range>"`; the resolved
    // node carries the target's name, and the alias lives only as the
    // descriptor key in the source manifest. Identity-aware so the seal
    // permits both the canonical and aliased edges from the same parent
    // to the same dst (e.g. a lockfile declaring both
    // `@scope/pkg` and an npm-aliased `@scope/pkg--variant`
    // against the same target).
    const dstName = nameOf(dstId)
    const attrs: { range: string; alias?: string } = { range: normalizedRange }
    if (depName !== dstName) attrs.alias = depName
    builder.addEdge(srcId, dstId, kind, attrs)
  }
}

function normalizedEdgeRange(kind: EdgeKind, range: string): string {
  if (kind === 'peer') return range
  // #119 NIT A — a GitHub shorthand (`dexus/pem`, `mischnic/buffer#…`) is kept
  // verbatim, exactly as the entry-key side (`entryKeyRangeOf`); only a true
  // prefix-less semver range gets the `npm:` default. This keeps the edge
  // `attrs.range` byte-identical to what yarn wrote so the dependency-block value
  // round-trips, and keeps the Rung-0 `lookup` aligned with the verbatim entry
  // key (`parseEntryKey` is github-shorthand-aware too — see `parseSpec`).
  return hasExplicitProtocol(range) || GITHUB_SHORTHAND_RE.test(range) ? range : `npm:${range}`
}

// Bug #104 — project a bound NodeId to its bare `${name}@${version}` key for the
// patch-sibling index lookup, stripping a peerContext `(...)` tail and a
// `+<slot>=…` disambiguator suffix. At parse time a Rung-0/3-bound base id is
// already bare (peerContext is empty pre-enrich, a registry base carries no patch
// slot), so this is identity in the common path; the strips are defensive for a
// form-a Rung-0 bind onto a patch node (whose `+patch=` suffix is removed so the
// lookup keys off the shared base `name@version`). `nameOf` is peerContext-depth-
// aware; the version is the segment after the last depth-0 `@`, minus any `+slot`.
export function nodeNameVersion(id: string): string | undefined {
  const name = nameOf(id)
  if (name.length >= id.length) return undefined
  let rest = id.slice(name.length + 1) // drop `name@`
  const parenIdx = rest.indexOf('(') // peerContext tail
  if (parenIdx >= 0) rest = rest.slice(0, parenIdx)
  const plusIdx = rest.indexOf('+') // TarballKey-style disambiguator slot
  if (plusIdx >= 0) rest = rest.slice(0, plusIdx)
  return rest.length > 0 ? `${name}@${rest}` : undefined
}

export function hasExplicitProtocol(range: string): boolean {
  const colonIdx = range.indexOf(':')
  if (colonIdx <= 0) return false
  const prefix = range.slice(0, colonIdx)
  return /^[a-z][a-z0-9+.-]*$/i.test(prefix)
}

function isLinkOrPortalRange(range: string): boolean {
  return range.startsWith('link:') || range.startsWith('portal:')
}

// Is this dependency range a `patch:` locator (`patch:<inner>#<patchPath>`)?
// True for a descriptor that references its dep DIRECTLY through a patch
// (Bug #88, form b). Form a — a plain `npm:`/`workspace:` range whose ENTRY
// merely happens to carry a `patch:` resolution — is NOT a patch range and
// resolves through the ordinary `specIndex` path (the entry key is the bare
// `npm:` descriptor), so it is unaffected here.
function isPatchRange(range: string): boolean {
  return range.startsWith('patch:')
}

// A patch ENTRY's locator (`<name>@patch:<inner>#<patchPath>::version=…&hash=…
// [&locator=…]`) and a consumer's `patch:` DESCRIPTOR (`<name>@patch:<inner>#
// <patchPath>`) differ only by the trailing `::`-param block yarn binds onto
// the entry. Strip that block — everything from the first `::` after the first
// `#` (the patch-path separator) — so both collapse to one bindable key. The
// descriptor (no params) is returned unchanged; the entry loses its
// `::version/hash/locator` suffix. Nested patch-of-patch locators stay safe:
// yarn percent-encodes the INNER locator's own `#`/`::` (`%23`/`%3A%3A`), so the
// first literal `#`/`::` always belong to the OUTER patch. Returns undefined for
// a non-patch input so callers can bail cheaply.
export function strippedPatchDescriptor(lookup: string): string | undefined {
  const patchIdx = lookup.indexOf('@patch:')
  if (patchIdx < 0) return undefined
  const hashIdx = lookup.indexOf('#', patchIdx)
  // No `#` ⇒ degenerate patch locator with no source fragment; the param block
  // (if any) still rides a `::` — strip from the first `::` anywhere after the
  // protocol so a malformed entry/descriptor pair still collapses identically.
  const paramsAnchor = hashIdx >= 0 ? hashIdx : patchIdx
  const paramsIdx = lookup.indexOf('::', paramsAnchor + 1)
  return paramsIdx < 0 ? lookup : lookup.slice(0, paramsIdx)
}

// Extract the `locator=<encoded-consumer>` qualifier from a patch entry-spec's
// `::`-param block, when present. Yarn writes it for a patch bound to a
// specific consumer (`…::version=…&hash=…&locator=root%40workspace%3A.`); it
// disambiguates the same patch applied from different workspaces. `spec` is the
// post-`patch:` body (`<inner>#<patchPath>::params`).
export function locatorQualifierOfPatchSpec(spec: string): string | undefined {
  const hashIdx = spec.indexOf('#')
  const paramsIdx = spec.indexOf('::', hashIdx >= 0 ? hashIdx + 1 : 0)
  if (paramsIdx < 0) return undefined
  for (const param of spec.slice(paramsIdx + 2).split('&')) {
    if (param.startsWith('locator=')) return param.slice('locator='.length)
  }
  return undefined
}

// Bug #104 — is this resolution a `@patch:` locator whose patched BASE is an
// `npm:` registry artefact (`<name>@patch:<name>@npm%3A<ver>#<patch>…`)? Only such
// patches are eligible for the patch-preference overlay: the base is a registry
// node a consumer's `npm:`/bare range can bind, so redirecting to the patched copy
// is the lock-borne yarn behaviour. A `~builtin<…>` patch, a patch of a git/file
// base, or a `link:`/`portal:`/`file:` locator-sentinel (no `@patch:` at all) is
// excluded. The inner base is `%3A`-encoded in the locator (`npm%3A`).
function isNpmBasePatchResolution(resolution: string, name: string): boolean {
  const locator = patchLocatorOfResolution(resolution)
  if (locator === undefined) return false
  // The patch source body sits between `patch:` and the first `#`; the patched
  // base locator is the body before that. Require the base to be `<name>@npm:…`.
  const base = baseSpecOfPatchLocator(locator)
  return base !== undefined && base.startsWith(`${name}@npm:`)
}

// Bug #104 — extract the `::locator=<encoded-consumer>` qualifier from a full
// patch RESOLUTION string (the `node.resolution` carrier), reusing the
// post-`patch:`-body extractor. Returns undefined when the patch is not bound to
// a specific consumer (no `locator=` in the `::`-param block).
function locatorQualifierOfPatchResolution(resolution: string): string | undefined {
  const locator = patchLocatorOfResolution(resolution)
  if (locator === undefined || !locator.startsWith('patch:')) return undefined
  return locatorQualifierOfPatchSpec(locator.slice('patch:'.length))
}

interface PatchDescriptorCandidate {
  id: string
  locatorQualifier?: string
}

// Resolve a consumer's bare `patch:` descriptor to its patch node. Single
// candidate → that node. Multiple candidates (same patch from different
// workspaces) → disambiguate by matching the `&locator=` qualifier against the
// source consumer's own resolution, exactly as the `link:`/`portal:` path does;
// no match → UNRESOLVED_DEP (ambiguous, return null so the generic fallback is
// suppressed). Empty/undefined candidate list → undefined (fall through).
function resolvePatchDescriptor(
  candidates: PatchDescriptorCandidate[] | undefined,
  srcResolution: string | undefined,
  srcId: string,
  lookup: string,
  diagnostics: Diagnostic[],
): string | undefined | null {
  if (candidates === undefined || candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]!.id

  if (srcResolution !== undefined) {
    const encoded = encodeURIComponent(srcResolution)
    const match = candidates.find(c => c.locatorQualifier === encoded)
    if (match !== undefined) return match.id
  }

  diagnostics.push({
    code: 'YARN_BERRY_UNRESOLVED_DEP',
    subject: srcId,
    severity: 'warning',
    message: `patch descriptor ${lookup} from ${srcId} is ambiguous across ${candidates.length} patch entries (no matching consumer locator)`,
  })
  return null
}

/**
 * Sync the verbatim entry-key descriptor sidecar with the edge mutations a
 * transaction applied. An `edge-added` contributes `<alias|name>@<range>` to the
 * dst entry's key (re-sorted to yarn's lexical order); an `edge-removed` retires
 * it. Only dst entries whose edges actually changed are rewritten — every other
 * entry, and any descriptor the edges never carried (a resolved-version or
 * `*`/`^3` range that lives ONLY in the source key — `entryKeyOfNode` cannot
 * rebuild those, which is why the verbatim sidecar exists), re-emits
 * byte-faithfully. Skips peer edges (never entry-key descriptors) and a dst with
 * no captured verbatim (a freshly-minted node — `entryKeyOfNode` reconstructs its
 * key from live edges). This is what keeps a BUMPED graph `--immutable`-clean:
 * the dst entry's key reflects the new consumer set, not the stale parse-time one
 * (qiwi/mware: `glob` gains `^10.2.2`, `@babel/generator@7.22.15` drops the now-
 * orphaned `^7.22.15`). Pure when nothing edge-changed (returns `sidecar`).
 */
function maintainEntryKeyDescriptors(
  sidecar: YarnBerryFamilySidecar,
  applied: readonly ChangeRecord[],
  oldGraph: Graph,
  newGraph: Graph,
): YarnBerryFamilySidecar {
  const ekd = sidecar.entryKeyDescriptors
  if (ekd === undefined) return sidecar

  // The dst entries whose incoming edges this transaction touched (an edge-add or
  // -remove). Only these can have drifted; everything else re-emits verbatim.
  const touchedDst = new Set<NodeId>()
  for (const rec of applied) {
    if ((rec.kind === 'edge-added' || rec.kind === 'edge-removed') && rec.subject.kind !== 'peer') {
      touchedDst.add(rec.subject.dst)
    } else if (rec.kind === 'node-removed') {
      // `removeNode` silently drops the node's OUT-edges (it emits only
      // `node-removed`, never per-edge `edge-removed`). Collect their dsts from
      // the OLD graph so the diff retires the removed consumer's descriptor from
      // each surviving dst's key — else a PRUNED pin-holder leaves a stale
      // exact-version descriptor the manager rejects (react-navigation
      // `@types/estree@npm:1.0.8`, mantine).
      for (const e of oldGraph.out(rec.subject)) {
        if (e.kind !== 'peer') touchedDst.add(e.dst)
      }
    }
  }
  if (touchedDst.size === 0) return sidecar

  let next: Map<string, string[]> | undefined
  for (const dst of touchedDst) {
    const current = ekd.get(dst)
    if (current === undefined) continue            // minted node — emit reconstructs from edges
    const dstNode = newGraph.getNode(dst)
    if (dstNode === undefined) continue            // dst gone — remapSidecar prunes its entry
    // Diff the dst's incoming-edge descriptor SET old→new. The range comes from
    // the edges themselves (robust to the rename's id churn), so a CHANGED edge
    // adds/drops exactly its `<alias|name>@<range>` on the key — while a verbatim
    // descriptor the edges never carried (`*`, a resolved-version pin) is never in
    // either set, so it is left untouched.
    const before = incomingKeyDescriptors(oldGraph, dst, dstNode.name)
    const after  = incomingKeyDescriptors(newGraph, dst, dstNode.name)
    let updated = current
    for (const d of before) if (!after.has(d)) updated = updated.filter(x => x !== d)
    for (const d of after) if (!before.has(d) && !updated.includes(d)) updated = [...updated, d]
    if (updated !== current) {
      next ??= new Map(ekd)
      next.set(dst, updated.slice().sort(cmpStr))
    }
  }
  return next === undefined ? sidecar : { ...sidecar, entryKeyDescriptors: next }
}

/** The set of entry-key descriptors a node's non-peer INCOMING edges contribute
 *  (`<alias|name>@<entry-key range>`) — the live half of its key. */
function incomingKeyDescriptors(graph: Graph, dst: NodeId, dstName: string): Set<string> {
  const out = new Set<string>()
  for (const e of graph.in(dst)) {
    if (e.kind === 'peer' || e.attrs?.range === undefined) continue
    // A governed edge carries the override pin as `overrideRange` — key by it
    // (yarn collapses `foo@^1` → `foo@<pin>` for a bare resolution), not the raw
    // declared range. Non-aliased edges only (the override keys on the package).
    const keyRange = e.attrs.alias === undefined ? (e.attrs.overrideRange ?? e.attrs.range) : e.attrs.range
    out.add(`${e.attrs.alias ?? dstName}@${entryKeyRangeOf(keyRange)}`)
  }
  return out
}

function remapSidecar(
  sidecar: YarnBerryFamilySidecar,
  nextNodes: Map<string, Node>,
  nextGraph: Graph,
): YarnBerryFamilySidecar {
  const remapped: YarnBerryFamilySidecar = {}

  if (sidecar.peerDependencies !== undefined) {
    const nextPeerDependencies = new Map<string, Record<string, string>>()
    for (const [oldId, block] of sidecar.peerDependencies) {
      nextPeerDependencies.set(nextNodes.get(oldId)?.id ?? oldId, block)
    }
    if (nextPeerDependencies.size > 0) remapped.peerDependencies = nextPeerDependencies
  }

  if (sidecar.conditions !== undefined) {
    const nextConditions = new Map<string, string>()
    for (const [oldId, scalar] of sidecar.conditions) {
      const nextId = nextNodes.get(oldId)?.id ?? oldId
      if (nextGraph.getNode(nextId) !== undefined) {
        nextConditions.set(nextId, scalar)
      }
    }
    if (nextConditions.size > 0) remapped.conditions = nextConditions
  }

  if (sidecar.dependenciesMeta !== undefined) {
    const next = new Map<string, SymlMap>()
    for (const [oldId, block] of sidecar.dependenciesMeta) {
      const nextId = nextNodes.get(oldId)?.id ?? oldId
      if (nextGraph.getNode(nextId) !== undefined) next.set(nextId, block)
    }
    if (next.size > 0) remapped.dependenciesMeta = next
  }

  if (sidecar.peerDependenciesMeta !== undefined) {
    const next = new Map<string, SymlMap>()
    for (const [oldId, block] of sidecar.peerDependenciesMeta) {
      const nextId = nextNodes.get(oldId)?.id ?? oldId
      if (nextGraph.getNode(nextId) !== undefined) next.set(nextId, block)
    }
    if (next.size > 0) remapped.peerDependenciesMeta = next
  }

  // F8/#103 — the unresolved-dep sidecar is per source NodeId; remap it through
  // a node-id rewrite (peer enrichment) exactly as the other per-node sidecars.
  if (sidecar.unresolvedDeps !== undefined) {
    const next = new Map<string, UnresolvedDepRef[]>()
    for (const [oldId, refs] of sidecar.unresolvedDeps) {
      const nextId = nextNodes.get(oldId)?.id ?? oldId
      if (nextGraph.getNode(nextId) !== undefined) next.set(nextId, refs)
    }
    if (next.size > 0) remapped.unresolvedDeps = next
  }

  // B-EXACT — the verbatim entry-key descriptor sidecar is per NodeId; remap it
  // through a peer-enrichment id rewrite (a peerContext change keeps the same
  // package/version, so the source key stays valid). A node whose id was REPLACED
  // by something other than a tracked remap (a version bump) drops out here, so
  // emit reconstructs a fresh key for the new node.
  if (sidecar.entryKeyDescriptors !== undefined) {
    const next = new Map<string, string[]>()
    for (const [oldId, descriptors] of sidecar.entryKeyDescriptors) {
      const nextId = nextNodes.get(oldId)?.id ?? oldId
      if (nextGraph.getNode(nextId) !== undefined) next.set(nextId, descriptors)
    }
    if (next.size > 0) remapped.entryKeyDescriptors = next
  }

  if (sidecar.metadata !== undefined) {
    remapped.metadata = sidecar.metadata
  }

  return remapped
}

function pruneSidecar(sidecar: YarnBerryFamilySidecar, nextGraph: Graph): YarnBerryFamilySidecar {
  const pruned: YarnBerryFamilySidecar = {}

  if (sidecar.peerDependencies !== undefined) {
    const nextPeerDependencies = new Map<string, Record<string, string>>()
    for (const [nodeId, block] of sidecar.peerDependencies) {
      if (nextGraph.getNode(nodeId) !== undefined) {
        nextPeerDependencies.set(nodeId, block)
      }
    }
    if (nextPeerDependencies.size > 0) pruned.peerDependencies = nextPeerDependencies
  }

  if (sidecar.conditions !== undefined) {
    const nextConditions = new Map<string, string>()
    for (const [nodeId, scalar] of sidecar.conditions) {
      if (nextGraph.getNode(nodeId) !== undefined) {
        nextConditions.set(nodeId, scalar)
      }
    }
    if (nextConditions.size > 0) pruned.conditions = nextConditions
  }

  if (sidecar.dependenciesMeta !== undefined) {
    const next = new Map<string, SymlMap>()
    for (const [nodeId, block] of sidecar.dependenciesMeta) {
      if (nextGraph.getNode(nodeId) !== undefined) next.set(nodeId, block)
    }
    if (next.size > 0) pruned.dependenciesMeta = next
  }

  if (sidecar.peerDependenciesMeta !== undefined) {
    const next = new Map<string, SymlMap>()
    for (const [nodeId, block] of sidecar.peerDependenciesMeta) {
      if (nextGraph.getNode(nodeId) !== undefined) next.set(nodeId, block)
    }
    if (next.size > 0) pruned.peerDependenciesMeta = next
  }

  // F8/#103 — drop the unresolved-dep sidecar for a node `optimize()` GC'd; keep
  // it for every surviving source node so its dropped refs still round-trip.
  if (sidecar.unresolvedDeps !== undefined) {
    const next = new Map<string, UnresolvedDepRef[]>()
    for (const [nodeId, refs] of sidecar.unresolvedDeps) {
      if (nextGraph.getNode(nodeId) !== undefined) next.set(nodeId, refs)
    }
    if (next.size > 0) pruned.unresolvedDeps = next
  }

  // B-EXACT — drop the verbatim key descriptors for a GC'd node; keep them for
  // every surviving node so its source key still re-emits byte-faithfully.
  if (sidecar.entryKeyDescriptors !== undefined) {
    const next = new Map<string, string[]>()
    for (const [nodeId, descriptors] of sidecar.entryKeyDescriptors) {
      if (nextGraph.getNode(nodeId) !== undefined) next.set(nodeId, descriptors)
    }
    if (next.size > 0) pruned.entryKeyDescriptors = next
  }

  if (sidecar.metadata !== undefined) {
    pruned.metadata = sidecar.metadata
  }

  return pruned
}

function isEmptySidecar(sidecar: YarnBerryFamilySidecar): boolean {
  return sidecar.peerDependencies === undefined
    && sidecar.conditions === undefined
    && sidecar.dependenciesMeta === undefined
    && sidecar.peerDependenciesMeta === undefined
    && sidecar.unresolvedDeps === undefined
    && sidecar.entryKeyDescriptors === undefined
    && sidecar.metadata === undefined
}

function unquoteMetadataScalar(output: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return output.replace(new RegExp(`^(  ${escapedKey}): "${escapedValue}"$`, 'm'), `$1: ${value}`)
}

// Strip the surrounding quotes the syml writer adds to a `conditions:` scalar so
// emit matches yarn's bare form (`conditions: os=darwin & cpu=arm64`). Only acts
// on an entry-level (2-space indent) `conditions: "..."` line whose quoted body
// contains no `\` escape — i.e. no embedded `"`, `\n`, `\t`, `\r`, or non-ASCII —
// which holds for every real yarn condition token. Any line with an escape is
// left quoted (lossless) rather than risk corrupting it.
function unquoteConditionsScalars(output: string): string {
  return output.replace(
    /^(  conditions): "([^"\\]*)"$/gm,
    (_m, key: string, body: string) => `${key}: ${body}`,
  )
}

// Strip the quotes the syml writer wraps around the BOOLEAN values inside a
// `dependenciesMeta:` / `peerDependenciesMeta:` block so emit matches yarn's bare
// form (`optional: true`, `built: false`, `unplugged: true`). The values reach
// emit as the STRINGS `'true'`/`'false'` (`coerceSymlValue` stringifies parsed
// booleans), and the generic writer quotes any value matching its YAML boolean
// pattern. yarn writes them BARE — and the distinction is load-bearing for
// `built`: `built: "false"` is a non-empty string → TRUTHY, so yarn would read
// `if (meta.built)` as `true` and run a postinstall the lock meant to suppress.
//
// Scope (no false positive on a legit string field whose value is literally
// `"true"`/`"false"`): the regex triple-gates on (1) exactly the meta-block VALUE
// indent — 6 spaces / nesting level 3 (entry `dependenciesMeta:` at 2, the pkg
// key at 4, the boolean key at 6), which in yarn-berry's emitted schema is
// reached ONLY inside these two meta blocks (every other entry field — `bin`,
// `dependencies`, `peerDependencies` — bottoms out one level shallower, and
// `conditions` is a scalar); (2) exactly the boolean KEYS yarn writes there
// (`optional`/`built`/`unplugged`); and (3) a value of exactly `"true"`/`"false"`.
// A genuine string field would have to satisfy all three to be touched, which the
// schema makes impossible. Runs BEFORE the CRLF conversion, mirroring the
// `conditions` unquote, so it matches on `\n`-terminated lines.
function unquoteMetaBooleanScalars(output: string): string {
  return output.replace(
    /^(      (?:optional|built|unplugged)): "(true|false)"$/gm,
    (_m, key: string, body: string) => `${key}: ${body}`,
  )
}
