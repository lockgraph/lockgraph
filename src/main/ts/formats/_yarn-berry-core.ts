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
  type EdgeAttrs,
  type EdgeKind,
  nameOf,
  serializeNodeId,
  type TarballPayload,
  toTarballKey,
  type TarballKeyInputs,
  type Diagnostic,
  type OverrideConstraint,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
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
  stringifyForYarnBerry,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  hashAndNormaliseBytes as patchHashAndNormaliseBytes,
  sentinelHashOfLocator,
} from '../recipe/patch.ts'
import { ambiguousResolutionDiagnostic, emitDropped, emitIntegrityIncomplete, patchNormalisedDiagnostic, patchPreferredDiagnostic, recipePeerMetaIncomplete, resolutionPinUnresolvedDiagnostic, unknownResolutionDiagnostic } from '../recipe/diagnostics.ts'
import { distTagResolve, overrideTargetFor, patchPreferenceFor, semverResolve, type PatchSibling, type SemverCandidate } from '../recipe/descriptor-resolve.ts'
import { readInstalledManifest, type InstalledManifestMeta } from '../complete/local-manifest.ts'

// Yarn-berry entry-spec grammar requires `<scheme>:` on every spec
// (`parseSpec` throws PARSE_FAILED otherwise). Cross-family inputs
// (pnpm-v9 bare semver ranges) lack the scheme — synthesise `npm:` so
// reparse stays well-formed. Per ADR-0016 §B `npm:` is the default
// protocol for registry packages.
const PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+\-.]*:/
function entryKeyRangeOf(range: string): string {
  return PROTOCOL_RE.test(range) ? range : `npm:${range}`
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
export interface YarnBerryFamilyOptimizeOptions {}

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

export function checkFamily(input: string, config: YarnBerryFamilyConfig): boolean {
  const head = input.slice(0, 4096)
  return new RegExp(
    `^__metadata:\\s*[\\r\\n]+(?:[ \\t]+[^\\n]*[\\r\\n]+)*?[ \\t]+version:\\s*${config.lockfileVersion}\\s*(?:[\\r\\n]|$)`,
    'm',
  ).test(head)
}

export function parseFamily(
  input: string,
  options: YarnBerryFamilyParseOptions,
  config: YarnBerryFamilyConfig,
): { graph: Graph; sidecar: YarnBerryFamilySidecar } {
  const ast = parseSyml(input)
  const metadata = validateMetadata(ast, config)

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const rawPeerDependencies = new Map<string, Record<string, string>>()
  const rawConditions = new Map<string, string>()
  const rawDependenciesMeta = new Map<string, SymlMap>()
  const rawPeerDependenciesMeta = new Map<string, SymlMap>()
  // F8/#103 — verbatim Rung-4-dropped dep refs (target absent from the lock),
  // keyed by source NodeId, collected during edge resolution and re-emitted into
  // the matching inner-block for byte-faithful same-format round-trip.
  const rawUnresolvedDeps = new Map<string, UnresolvedDepRef[]>()
  // B-EXACT — verbatim entry-key descriptor list per NodeId, captured below so
  // emit re-keys each entry from the SOURCE descriptors (never a synthesized
  // resolved-version). See `YarnBerryFamilySidecar.entryKeyDescriptors`.
  const rawEntryKeyDescriptors = new Map<string, string[]>()

  const entries: Array<{ key: string; value: SymlMap; specs: SpecPart[] }> = []
  for (const [key, value] of Object.entries(ast)) {
    if (key === '__metadata') continue
    const valueMap = asMap(value)
    if (!valueMap) {
      diagnostics.push({
        code: 'YARN_BERRY_BAD_ENTRY',
        severity: 'warning',
        message: `entry ${JSON.stringify(key)} is not a block; skipping`,
      })
      continue
    }
    const specs = parseEntryKey(key)
    entries.push({ key, value: valueMap, specs })
  }

  const specIndex = new Map<string, string>()
  // A `patch:` consumer descriptor (`patch:<inner>#<patchPath>`) is the patch
  // ENTRY's locator with its trailing `::version=…&hash=…[&locator=…]` param
  // block stripped — yarn appends those params only on the bound entry, never
  // on the consumer's descriptor (Bug #88, form b). So the bare descriptor can
  // never hit `specIndex` directly. Index every patch entry under its
  // param-stripped descriptor so a `patch:`-descriptor dep resolves to the
  // patch NODE (the `+patch=…` node), not the plain `npm:` node. Multiple patch
  // entries can strip to the same descriptor (same patch applied from different
  // workspaces → distinct `&locator=` qualifiers → distinct sentinel nodes), so
  // each candidate carries its `locator=` for consumer disambiguation, mirroring
  // the `link:`/`portal:` path.
  const patchDescriptorIndex = new Map<string, PatchDescriptorCandidate[]>()
  // Bug #99 Rung-3 — name → registry-class candidate index for source-gated
  // max-satisfying semver. Built alongside the node table because the resolver
  // runs against the WRITE-ONLY builder (no `graph.byName` / `graph.tarballOf`
  // available yet). Each candidate carries the F3 source class so the resolver
  // can keep an `npm:`/bare descriptor from ever binding a git/directory/unknown
  // node (the #91 source-safety invariant).
  const semverCandidatesByName = new Map<string, SemverCandidate[]>()
  // Bug #104 patch-preference — `${name}@${version}` → sibling PATCH nodes whose
  // canonical base is an `npm:` registry artefact (`node.patch !== undefined` and
  // the patch locator's inner protocol is `npm:`). Built alongside the candidate
  // index so the Rung-3 OVERLAY can, after a registry range binds the BASE node,
  // redirect the consumer onto the patched copy (yarn's lock-borne
  // `patchedDependencies` behaviour). Keyed by the patch node's own
  // `name@version` (which equals the base's), so the bound base id maps straight
  // to its patch siblings. `link:`/`portal:`/`file:` locator-disambiguated
  // sentinels are EXCLUDED (their "patch" slot carries only a consumer
  // discriminator, not a registry-base patch).
  const patchSiblingsByBase = new Map<string, PatchSibling[]>()
  const seenIds = new Set<string>()
  const entryIds = new Map<string, string>()

  for (const { key, value, specs } of entries) {
    const first = specs[0]
    if (!first) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `entry ${JSON.stringify(key)} has empty spec`,
      })
    }
    const version = asString(value['version'])
    if (version === undefined) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `entry ${JSON.stringify(key)} missing 'version'`,
      })
    }
    const resolution = asString(value['resolution'])
    // Authoritative name comes from the `resolution:` locator when present
    // (ADR-0014 §4.F3 — single canonical identity). Compound entry-keys can
    // sort an npm-alias spec ahead of the canonical spec lexically (e.g.
    // `@scope/pkg--variant@npm:@scope/pkg@…,
    //  @scope/pkg@npm:…`); keying off `first.name` mistakes the alias
    // for the real package name. Falling back to `first.name` keeps legacy
    // single-spec / sentinel-version entries intact.
    const authoritativeName = resolution !== undefined
      ? nameFromResolutionLocator(resolution) ?? first.name
      : first.name
    const baseId = serializeNodeId(authoritativeName, version, [])
    const rawPatchResult = resolution !== undefined
      ? extractPatchFingerprint(baseId, resolution, options.workspaceRoot)
      : undefined
    // Local-artefact locator-disambiguator (per ADR-0011 sentinel-as-
    // discriminator pattern): `link:` / `portal:` directory references and a
    // `::locator=`-qualified `file:` local-tarball alias. Only kicks in when no
    // `@patch:` fingerprint already populates the slot — `@patch:` wins because
    // it carries actual byte-identity semantics; these locators carry only a
    // consumer-ownership discriminator. Keyed off authoritativeName (the
    // resolution-derived canonical name) so it stays correct under the
    // compound-entry-key alias-ordering case Bug #3 fixes.
    const linkLocatorPatch = rawPatchResult === undefined && resolution !== undefined
      && isLocalLocatorDisambiguatedResolution(resolution, authoritativeName)
      ? sentinelHashOfLocator(resolution)
      : undefined
    const effectivePatch = rawPatchResult?.patch ?? linkLocatorPatch
    const id = serializeNodeId(authoritativeName, version, [], effectivePatch)
    const patchResult = rawPatchResult?.diagnostic !== undefined
      ? {
          ...rawPatchResult,
          diagnostic: {
            ...rawPatchResult.diagnostic,
            subject: id,
          },
        }
      : rawPatchResult

    if (seenIds.has(id)) {
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: irreducibleCollisionMessage(id, key, entries),
      })
    }
    seenIds.add(id)
    entryIds.set(key, id)
    // B-EXACT — remember the VERBATIM source key descriptors so emit re-keys this
    // entry from exactly what yarn wrote (split on `, ` mirrors `parseEntryKey`),
    // never synthesizing the resolved version into the key.
    rawEntryKeyDescriptors.set(id, key.split(', '))

    const node: Node = {
      id,
      name: authoritativeName,
      version,
      peerContext: [],
    }
    if (resolution !== undefined) node.resolution = resolution
    if (effectivePatch !== undefined) node.patch = effectivePatch
    // Workspace identification keys off `resolution` (the canonical, single
    // identity per ADR-0014 §4.F3), not `specs[0].protocol`. A compound entry
    // may list `<n>@npm:<ver>, <n>@workspace:<path>` in any order — the npm
    // alias claims spec[0] when it sorts first lexically, yet the entry is
    // still the local workspace (resolution is authoritative). Falling back
    // to `first.spec` only when resolution is absent preserves the legacy
    // single-spec workspace shape (`<n>@workspace:<path>`).
    const workspaceSpec = workspaceSpecOfEntry(resolution, specs, first)
    if (workspaceSpec !== undefined) {
      node.workspacePath = workspacePathOf(workspaceSpec)
    }
    builder.addNode(node)
    if (patchResult?.diagnostic) diagnostics.push(patchResult.diagnostic)

    // ADR-0014 §4.F3 — canonical resolution into TarballPayload. Workspace
    // identity is NOT part of F3 canonical (it lives on Node.workspacePath);
    // skip the primitive entirely for workspace-protocol locators (driven by
    // the resolution, not by spec[0] — see workspaceSpec derivation above).
    const canonicalResolution = resolution !== undefined && workspaceSpec === undefined
      ? parseResolutionRecipe(resolution, { sourceKind: 'yarn-berry-locator', name: authoritativeName })
      : undefined
    if (canonicalResolution !== undefined && canonicalResolution.type === 'unknown' && !looksLikePatchLocator(resolution)) {
      diagnostics.push(unknownResolutionDiagnostic(id, resolution!))
    }

    // Bug #99 Rung-3 — register this node as a max-satisfying-semver candidate
    // under its authoritative name. The source class is the F3 canonical type
    // (`'absent'` when no resolution canonicalised — a workspace node, or an
    // entry with no `resolution:` field); only `tarball` candidates are ever
    // eligible for an `npm:`/bare match, enforced inside `semverResolve`. A patch
    // node carries `canonicalResolution.type === 'unknown'` (patch: → unknown per
    // recipe/resolution.ts) so it is correctly invisible to a registry range —
    // the bare `npm:` node remains the semver target; the patch is reached via
    // the Rung-1 patch-descriptor path.
    const semverCandidate: SemverCandidate = {
      id,
      version,
      sourceType: canonicalResolution?.type ?? 'absent',
    }
    const candidateList = semverCandidatesByName.get(authoritativeName)
    if (candidateList === undefined) semverCandidatesByName.set(authoritativeName, [semverCandidate])
    else candidateList.push(semverCandidate)

    // Bug #104 — register a registry-base PATCH node as a patch sibling of its
    // base `name@version`. Gate on `effectivePatch !== undefined` (a patch slot
    // is set) AND the resolution being a genuine `@patch:` of an `npm:` base
    // (excludes the `link:`/`portal:`/`file:` locator-disambiguated sentinels,
    // which set `effectivePatch` only as a consumer discriminator). The
    // `::locator=` qualifier disambiguates ≥2 siblings of the same base.
    if (effectivePatch !== undefined && resolution !== undefined && isNpmBasePatchResolution(resolution, authoritativeName)) {
      const sibling: PatchSibling = { id, locatorQualifier: locatorQualifierOfPatchResolution(resolution) }
      const baseKey = `${authoritativeName}@${version}`
      const siblings = patchSiblingsByBase.get(baseKey)
      if (siblings === undefined) patchSiblingsByBase.set(baseKey, [sibling])
      else siblings.push(sibling)
    }

    const peerDependencies = stringRecordOfBlock(asMap(value['peerDependencies']))
    if (peerDependencies !== undefined) {
      rawPeerDependencies.set(id, peerDependencies)
    }

    // `conditions:` is a SCALAR (`os=darwin & cpu=arm64`), captured verbatim.
    // The prior `coerceSymlMap` coercion silently dropped it (a scalar is not
    // an object → undefined), losing the platform gate on @esbuild/@swc/sharp
    // optional binaries (task #89 / closes #85).
    const conditions = asString(value['conditions'])
    if (conditions !== undefined) {
      rawConditions.set(id, conditions)
    }

    // `dependenciesMeta:` ({ pkg: { optional|built|… } }) — verbatim per-node
    // round-trip sidecar (task #89). No EdgeAttrs translation (out of scope).
    const dependenciesMeta = coerceSymlMap(value['dependenciesMeta'])
    if (dependenciesMeta !== undefined) {
      rawDependenciesMeta.set(id, dependenciesMeta)
    }

    // `peerDependenciesMeta:` ({ peer: { optional: true } }) — captured verbatim
    // and re-emitted through `peerDependenciesMetaOfNode` (the #86 machinery) as
    // its rung-0 hint; `enrich` additionally folds `optional` onto the derived
    // peer edge so berry→berry and pnpm→berry share one emit path.
    const peerDependenciesMeta = coerceSymlMap(value['peerDependenciesMeta'])
    if (peerDependenciesMeta !== undefined) {
      rawPeerDependenciesMeta.set(id, peerDependenciesMeta)
    }

    const payload: TarballPayload = {}
    const checksum = asString(value['checksum'])
    if (checksum !== undefined) {
      // Berry `checksum` is a digest of yarn's zip-cache — NOT the tarball:
      // bare sha512 hex (pre-v8) or `<cacheKey>/<sha512-hex>` (v8/v9). It is
      // parsed as a `berry-zip`-origin sha512 so it is never re-encoded into a
      // tarball SRI on emit. sha1/sha256/malformed bodies yield no hash and are
      // rejected with a diagnostic, leaving the integrity slot undefined.
      const { integrity, cacheKey: checksumCacheKey } = parseBerryChecksum(checksum)
      if (isEmptyIntegrity(integrity)) {
        diagnostics.push({
          code:     `${config.codePrefix}_INVALID_INTEGRITY`,
          severity: 'warning',
          subject:  id,
          message:  `checksum ${JSON.stringify(checksum)} is not a sha512 berry checksum; dropping integrity`,
        })
      } else {
        payload.integrity = integrity
        // Round-trip the `<cacheKey>/` prefix verbatim (ADR-0031): preserve it
        // IFF the source carried one, for EVERY berry generation (yarn-2.0 `2/`
        // through v8/v9 `10c0/`). A bare source leaves this undefined → bare
        // emit, so the bare-v4/v7 shape stays bare.
        if (checksumCacheKey !== undefined) payload.berryChecksumCacheKey = checksumCacheKey
      }
    }
    const binMap = asMap(value['bin'])
    if (binMap) {
      const bin: Record<string, string> = {}
      for (const [name, target] of Object.entries(binMap)) {
        if (typeof target === 'string') bin[name] = target
      }
      if (Object.keys(bin).length > 0) payload.bin = bin
    }
    // ADR-0014 §4.F3 — workspace canonical lives on Node.workspacePath
    // (per-format), not on TarballPayload (which is for cross-format
    // artefact metadata). Workspace inputs already bypass the primitive
    // above, so `canonicalResolution` is guaranteed non-workspace here.
    if (canonicalResolution !== undefined) {
      payload.resolution = canonicalResolution
    }
    if (Object.keys(payload).length > 0) {
      // Key MUST match the NodeId built above: authoritativeName (Bug #3
      // canonical-name) + effectivePatch (Bug #2 link/portal locator slot).
      builder.setTarball({ name: authoritativeName, version, patch: effectivePatch }, payload)
    }

    for (const spec of specs) {
      const lookup = `${spec.name}@${spec.protocol}:${spec.spec}`
      // Cross-family emit can intentionally advertise the same spec from
      // multiple sibling entries to preserve source-graph edge targets when
      // the input lacks yarn-native resolution sidecars. Keep the first
      // claimant (entries are already in deterministic source order) so
      // parse-side resolution stays stable instead of drifting on overwrite.
      if (!specIndex.has(lookup)) {
        specIndex.set(lookup, id)
      }
      // Bug #88 (form b): also index a `patch:` entry-spec under its
      // param-stripped descriptor so a consumer that references the dep
      // DIRECTLY via the `patch:` locator (no `::version/hash` block) links to
      // this patch node. Source order is deterministic, so candidates within a
      // descriptor stay stably ordered for disambiguation/ambiguity reporting.
      if (spec.protocol === 'patch') {
        const stripped = strippedPatchDescriptor(lookup)
        if (stripped !== undefined) {
          const candidates = patchDescriptorIndex.get(stripped) ?? []
          candidates.push({ id, locatorQualifier: locatorQualifierOfPatchSpec(spec.spec) })
          patchDescriptorIndex.set(stripped, candidates)
        }
      }
    }
  }

  // Bug #99 — bundle the descriptor→node ladder's Rung-2/3 inputs once; passed
  // to every edge-resolution call so the steady-state Rung-0 path is untouched.
  const ladderCtx: EdgeLadderContext = {
    candidatesByName: semverCandidatesByName,
    patchSiblingsByBase,
    overrides:        options.overrides ?? [],
    codePrefix:       config.codePrefix,
    manifestsProvided: options.overrides !== undefined,
  }

  for (const { key, value, specs } of entries) {
    const first = specs[0]
    if (!first) continue
    const srcId = entryIds.get(key)
    if (srcId === undefined) continue

    // The source entry's own resolution doubles as its locator for resolving
    // any `link:` / `portal:` deps it declares (see addEdgesFromBlock).
    const srcResolution = asString(value['resolution'])
    addEdgesFromBlock(builder, srcId, asMap(value['dependencies']), 'dep', specIndex, patchDescriptorIndex, diagnostics, ladderCtx, srcResolution, rawUnresolvedDeps)
    addEdgesFromBlock(builder, srcId, asMap(value['optionalDependencies']), 'optional', specIndex, patchDescriptorIndex, diagnostics, ladderCtx, srcResolution, rawUnresolvedDeps)
  }

  // Sort diagnostics by subject + code to keep graph.diagnostics() order
  // independent of source-file entry order (recipe-layer diagnostics fire
  // per-entry on parse; round-trips that re-sort entries on emit would
  // otherwise produce a re-ordered diagnostic list).
  diagnostics.sort((a, b) => {
    const sa = typeof a.subject === 'string' ? a.subject : ''
    const sb = typeof b.subject === 'string' ? b.subject : ''
    return cmpStr(sa, sb) || cmpStr(a.code, b.code)
  })
  for (const diagnostic of diagnostics) builder.diagnostic(diagnostic)

  try {
    const sealed = builder.seal()
    // ADR-0014 §4.F4 — parse-side workspace marking. Edges whose source
    // range carries the `workspace:` protocol AND whose target is a
    // workspace member node get `attrs.workspace = true` plus the
    // canonical workspaceRange sidecar. The same logic also runs in
    // enrichFamily для downstream rebuilds; doing it here ensures the
    // public `parse()` surface (and convert without explicit enrich)
    // delivers F4-ready edges.
    const graph = markWorkspaceEdgesAtParse(sealed)
    const sidecar: YarnBerryFamilySidecar = {}
    if (rawPeerDependencies.size > 0) sidecar.peerDependencies = rawPeerDependencies
    if (rawConditions.size > 0) sidecar.conditions = rawConditions
    if (rawDependenciesMeta.size > 0) sidecar.dependenciesMeta = rawDependenciesMeta
    if (rawPeerDependenciesMeta.size > 0) sidecar.peerDependenciesMeta = rawPeerDependenciesMeta
    if (rawUnresolvedDeps.size > 0) sidecar.unresolvedDeps = rawUnresolvedDeps
    if (rawEntryKeyDescriptors.size > 0) sidecar.entryKeyDescriptors = rawEntryKeyDescriptors
    if (metadata !== undefined) sidecar.metadata = metadata
    rememberSidecar(graph, sidecar)
    // Wrap so that any subsequent graph.mutate() call propagates the sidecar
    // (including __metadata.cacheKey) to the returned graph instance.
    const wrappedGraph = withSidecarPropagation(graph, sidecar)
    return { graph: wrappedGraph, sidecar }
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

export function stringifyFamily(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyStringifyOptions = {},
): { lockfile: string; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  const diagnostics: Diagnostic[] = []
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic)
    options.onDiagnostic?.(diagnostic)
  }

  const metadata: SymlMap = { version: String(config.lockfileVersion) }
  const cacheKey = options.cacheKey ?? asString(sidecar.metadata?.cacheKey)
  if (cacheKey !== undefined) {
    metadata['cacheKey'] = cacheKey
  }
  if (sidecar.metadata !== undefined) {
    for (const key of Object.keys(sidecar.metadata).sort(cmpStr)) {
      if (key === 'version' || key === 'cacheKey') continue
      const value = cloneSymlValue(sidecar.metadata[key])
      if (value !== undefined) {
        metadata[key] = value
      }
    }
  }

  const root: SymlMap = { __metadata: metadata }
  const entries = Array.from(graph.nodes(), node => ({
    nodeId: node.id,
    key: entryKeyOfNode(graph, node),
    value: entryOfNode(graph, node, config, emitDiagnostic, cacheKey),
  })).sort((a, b) => cmpStr(a.key, b.key))

  const seenIds = new Map<string, string>()
  for (const entry of entries) {
    const node = graph.getNode(entry.nodeId)
    const emitId = node === undefined
      ? entry.nodeId
      : toTarballKey({ name: node.name, version: node.version, patch: node.patch })
    const prevNodeId = seenIds.get(emitId)
    if (prevNodeId !== undefined) {
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `duplicate node id collides on emit: ${emitId} from ${prevNodeId}, ${entry.nodeId}`,
      })
    }
    seenIds.set(emitId, entry.nodeId)
    root[entry.key] = entry.value
  }

  let output = `${PREAMBLE}\n\n${stringifySyml(root)}`
  output = unquoteMetadataScalar(output, 'version', String(config.lockfileVersion))
  if (cacheKey !== undefined && /^-?(0|[1-9][0-9]*)$/.test(cacheKey)) {
    output = unquoteMetadataScalar(output, 'cacheKey', cacheKey)
  }
  const compressionLevel = sidecar.metadata?.compressionLevel
  if (typeof compressionLevel === 'string' && /^-?(0|[1-9][0-9]*)$/.test(compressionLevel)) {
    output = unquoteMetadataScalar(output, 'compressionLevel', compressionLevel)
  }
  // `conditions:` is emitted bare by yarn even though its value carries spaces /
  // `&` / `( | )` (which the syml writer would quote). Strip the quotes off every
  // `conditions:` scalar so the round-trip matches yarn byte-for-byte. Safe: yarn
  // condition tokens never contain `"`, `\`, or newlines, so an unquote only ever
  // recovers the original literal (and we bail on any line that does).
  output = unquoteConditionsScalars(output)
  // `dependenciesMeta:` / `peerDependenciesMeta:` boolean values emit BARE too
  // (`optional: true`, `built: false`, `unplugged: true`) — same post-pass slot
  // (before CRLF conversion) so the line anchors hold. `built: "false"` is a
  // TRUTHY non-empty string, so the bare emit is correctness, not just fidelity.
  output = unquoteMetaBooleanScalars(output)
  if (options.lineEnding === 'crlf') {
    output = output.replace(/\n/g, '\r\n')
  }

  return { lockfile: output, diagnostics }
}

export function enrichFamily(
  graph: Graph,
  config: YarnBerryFamilyConfig,
  options: YarnBerryFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  const rawPeerDependencies = sidecar.peerDependencies ?? new Map<string, Record<string, string>>()
  const derivedPeersByNodeId = new Map<string, DerivedPeer[]>()
  const pendingDiagnostics: PendingDiagnostic[] = []
  let peerChanged = false

  for (const node of graph.nodes()) {
    const rawPeers = rawPeerDependencies.get(node.id)
    if (rawPeers === undefined || node.peerContext.length > 0 || graph.out(node.id, 'peer').length > 0) {
      continue
    }

    const derivedPeers: DerivedPeer[] = []
    for (const [peerName, range] of Object.entries(rawPeers).sort((a, b) => cmpStr(a[0], b[0]))) {
      const normalizedRange = semver.validRange(range)
      if (normalizedRange === null) {
        throw new LockfileError({
          code: 'INVALID_INPUT',
          message: `invalid peer range for ${node.id}: ${peerName}@${range}`,
        })
      }

      const candidates = graph.byName(peerName)
        .filter(candidateId => {
          const candidate = graph.getNode(candidateId)
          return candidate !== undefined
            && semver.valid(candidate.version) !== null
            && semver.satisfies(candidate.version, normalizedRange)
        })
        .slice()
        .sort(cmpStr)

      if (candidates.length === 1) {
        derivedPeers.push({ name: peerName, range, dstOldId: candidates[0]! })
        peerChanged = true
        continue
      }

      if (candidates.length === 0) {
        pendingDiagnostics.push({
          code: `${config.codePrefix}_PEER_UNSATISFIED`,
          severity: 'warning',
          subject: node.id,
          message: `peer "${peerName}" range "${range}" matches no installed version`,
        })
        continue
      }

      pendingDiagnostics.push({
        code: `${config.codePrefix}_PEER_AMBIGUOUS`,
        severity: 'warning',
        subject: node.id,
        peerName,
        candidateIds: candidates,
        message: ambiguousPeerMessage(peerName, candidates),
      })
    }

    if (derivedPeers.length > 0) {
      derivedPeersByNodeId.set(node.id, derivedPeers)
    }
  }

  // === peerDependenciesMeta reconstruction (task #86) =======================
  // For every `peer` edge lacking an `optional` signal, run the fill ladder
  // (rung-1 graph already on the edge → rung-2 local node_modules manifest →
  // opt-in rung-3/4 resolver) against the PARENT package's
  // peerDependenciesMeta[peer].optional. When optional → mark the edge; when
  // unreconstructable → RECIPE_PEER_META_INCOMPLETE (warning, omit not guess).
  // Monotone-additive (union, never clear) and idempotent: a second pass sees
  // the flag already set on rung-1 and makes no change / no new diagnostic.
  const peerMetaCtx = createPeerMetaContext(options)
  const peerOptionalOverrides = new Map<string, boolean>()
  let peerMetaChanged = false
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id, 'peer')) {
      if (edge.attrs?.optional === true) continue // rung-1: already optional.
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      const optional = resolvePeerOptional(graph, peerMetaCtx, node, dst.name, pendingDiagnostics)
      if (optional === true) {
        peerOptionalOverrides.set(peerEdgeKey(edge.src, edge.dst), true)
        peerMetaChanged = true
      }
    }
  }
  // Derived peer edges (yarn-berry raw-sidecar source) do not exist on the
  // graph yet — run the same ladder so they emit the flag on first pass too.
  // Rung-0 first: a real berry lock already records `peerDependenciesMeta[peer]
  // .optional` verbatim (task #89), which is authoritative — consult it before
  // the external fill ladder so a berry→berry enrich stamps `optional` onto the
  // derived edge without any node_modules/resolver lookup (and emits no
  // RECIPE_PEER_META_INCOMPLETE for a peer the lock already answered).
  let derivedPeerOptionalChanged = false
  for (const [srcId, derivedPeers] of derivedPeersByNodeId) {
    const node = graph.getNode(srcId)
    if (node === undefined) continue
    for (const peer of derivedPeers) {
      const dst = graph.getNode(peer.dstOldId)
      const peerName = dst?.name ?? peer.name
      if (berryMetaPeerOptional(graph, srcId, peerName)) {
        peer.optional = true
        derivedPeerOptionalChanged = true
        continue
      }
      if (resolvePeerOptional(graph, peerMetaCtx, node, peerName, pendingDiagnostics) === true) {
        peer.optional = true
        derivedPeerOptionalChanged = true
      }
    }
  }

  const workspaceChanged = graphNeedsWorkspaceAttribution(graph)
  if (!peerChanged && !workspaceChanged && !peerMetaChanged && !derivedPeerOptionalChanged) {
    return {
      graph,
      diagnostics: pendingDiagnostics.map(diagnostic => finalizePendingDiagnostic(diagnostic, new Map())),
    }
  }

  const finalNodeIds = deriveFinalNodeIds(graph, derivedPeersByNodeId)
  const nextNodes = new Map<string, Node>()
  for (const node of graph.nodes()) {
    const derivedPeers = derivedPeersByNodeId.get(node.id)
    if (derivedPeers === undefined) {
      nextNodes.set(node.id, node)
      continue
    }

    const peerContext = sortPeerContext(derivedPeers.map(peer => finalNodeIds.get(peer.dstOldId) ?? peer.dstOldId))
    const newId = finalNodeIds.get(node.id) ?? node.id
    nextNodes.set(node.id, {
      ...node,
      id: newId,
      peerContext,
    })
  }

  const builder = newBuilder()
  for (const node of graph.nodes()) {
    builder.addNode(nextNodes.get(node.id) ?? node)
  }

  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      const nextSrc = nextNodes.get(edge.src)?.id ?? edge.src
      const nextDst = nextNodes.get(edge.dst)?.id ?? edge.dst
      let nextAttrs = edge.attrs

      if (edge.kind !== 'peer' && edge.attrs?.workspace !== true && isDerivedWorkspaceRange(edge.attrs?.range)) {
        const dstNode = graph.getNode(edge.dst)
        if (dstNode?.workspacePath !== undefined) {
          // ADR-0014 §4.F4 — populate canonical workspaceRange sidecar
          // via shared `deriveMarkedWorkspaceAttrs` (also driven by the
          // parse-time `markWorkspaceEdgesAtParse` pass).
          nextAttrs = deriveMarkedWorkspaceAttrs(edge.attrs, dstNode)
        }
      }

      // task #86 — union the reconstructed peer-optional flag (never clear).
      if (edge.kind === 'peer' && peerOptionalOverrides.has(peerEdgeKey(edge.src, edge.dst))) {
        nextAttrs = { ...(nextAttrs ?? {}), optional: true }
      }

      builder.addEdge(nextSrc, nextDst, edge.kind, nextAttrs)
    }
  }

  for (const [srcOldId, derivedPeers] of derivedPeersByNodeId) {
    const srcNewId = nextNodes.get(srcOldId)?.id ?? srcOldId
    for (const peer of derivedPeers) {
      const dstNewId = nextNodes.get(peer.dstOldId)?.id ?? peer.dstOldId
      const peerAttrs: EdgeAttrs = { range: peer.range }
      if (peer.optional === true) peerAttrs.optional = true // task #86
      builder.addEdge(srcNewId, dstNewId, 'peer', peerAttrs)
    }
  }

  for (const node of graph.nodes()) {
    const payload = graph.tarballOf(node.id)
    if (payload === undefined) continue
    builder.setTarball({ name: node.name, version: node.version, patch: node.patch }, payload)
  }
  for (const diagnostic of graph.diagnostics()) {
    builder.diagnostic(diagnostic)
  }
  const layoutHints = graph.layoutHints()
  if (layoutHints !== undefined) {
    builder.layoutHints(layoutHints)
  }

  const nextGraph = builder.seal()
  rememberSidecar(nextGraph, remapSidecar(sidecar, nextNodes, nextGraph))

  return {
    graph: nextGraph,
    diagnostics: pendingDiagnostics.map(diagnostic => finalizePendingDiagnostic(diagnostic, nextNodes)),
  }
}

export function optimizeFamily(
  graph: Graph,
  _options: YarnBerryFamilyOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph) ?? EMPTY_SIDECAR
  const reachable = new Set(graph.walk(Array.from(graph.roots())))
  const unreachableNodes = Array.from(graph.nodes(), node => node.id)
    .filter(nodeId => !reachable.has(nodeId))
    .sort(cmpStr)

  if (unreachableNodes.length === 0) {
    return {
      graph,
      diagnostics: graph.diagnostics().filter(diagnostic => diagnostic.severity === 'warning'),
    }
  }

  const unreachable = new Set(unreachableNodes)
  const referencedTarballs = new Set<string>()
  const tarballsToRemove = new Map<string, TarballKeyInputs>()
  const internalEdges = unreachableNodes
    .flatMap(src =>
      graph.out(src)
        .filter(edge => unreachable.has(edge.dst))
        .map(edge => ({ src: edge.src, dst: edge.dst, kind: edge.kind })),
    )
    .sort((a, b) =>
      cmpStr(`${a.src}\u0000${a.kind}\u0000${a.dst}`, `${b.src}\u0000${b.kind}\u0000${b.dst}`),
    )

  for (const node of graph.nodes()) {
    const inputs = { name: node.name, version: node.version, patch: node.patch }
    const key = toTarballKey(inputs)
    if (unreachable.has(node.id)) {
      tarballsToRemove.set(key, inputs)
      continue
    }
    referencedTarballs.add(key)
  }

  const result = graph.mutate(m => {
    for (const edge of internalEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const nodeId of unreachableNodes) {
      m.removeNode(nodeId)
    }
    for (const [key, inputs] of Array.from(tarballsToRemove.entries()).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (!referencedTarballs.has(key)) {
        m.removeTarball(inputs)
      }
    }
  })

  rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  return { graph: result.graph, diagnostics: result.unresolved ?? [] }
}

export function rememberSidecar(graph: Graph, sidecar: YarnBerryFamilySidecar): void {
  if (isEmptySidecar(sidecar)) return
  sidecarByGraph.set(graph, sidecar)
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
 * nodeId remapping: when a `replaceNode` or `replacePeerContext` change is
 * recorded, the old nodeId is no longer in the graph; the sidecar's
 * peerDependencies / conditions maps are keyed by nodeId, so we remap them
 * through the applied ChangeRecord list exactly as `remapSidecar` does for
 * `enrichFamily`.
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
        // Build a nodeId remap from applied ChangeRecords so peerDependencies
        // and conditions survive replaceNode / replacePeerContext mutations.
        const idRemap = new Map<string, string>()
        for (const rec of result.applied) {
          if (rec.kind === 'node-replaced' || rec.kind === 'peer-context-replaced') {
            // rec.subject is the NEW id; we need the old id to find the sidecar entry.
            // We cannot recover the old id from a ChangeRecord alone, but we can scan
            // the old graph's nodes and see which ones are missing in the new graph.
            // Rather than a full scan here, we rely on `remapSidecar` which iterates
            // the old sidecar's keyed entries and maps unknown ids through the remap.
            // Since we don't track old→new pairs in ChangeRecord, we pass an empty
            // remap Map and let `remapSidecar`'s fallback (`?? oldId`) handle it —
            // unchanged ids (most cases) survive as-is; replaced ids whose old-id
            // no longer exists in nextGraph are simply pruned by `pruneSidecar`.
            void rec
          }
        }
        const nextNodes = new Map<string, Node>()
        // No old→new id mapping available from ChangeRecord; metadata (cacheKey etc.)
        // is global and does not need remapping. peerDependencies/conditions that refer
        // to a replaced node's old id will be pruned by the nextGraph membership check
        // inside remapSidecar — matching the behaviour of enrichFamily.
        const nextSidecar = remapSidecar(sidecar, nextNodes, result.graph)
        // If remapSidecar pruned everything (replaced nodes), fall back to at least
        // preserving the format-level metadata (cacheKey, compressionLevel, etc.)
        // which is not node-keyed and should always survive any mutation.
        const effectiveSidecar: YarnBerryFamilySidecar = isEmptySidecar(nextSidecar) && sidecar.metadata !== undefined
          ? { metadata: sidecar.metadata }
          : nextSidecar
        rememberSidecar(result.graph, effectiveSidecar)
        return {
          ...result,
          graph: withSidecarPropagation(result.graph, effectiveSidecar),
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

export function rawDependenciesMetaBlockOfNode(graph: Graph, nodeId: string): SymlMap | undefined {
  const block = sidecarByGraph.get(graph)?.dependenciesMeta?.get(nodeId)
  return block === undefined ? undefined : coerceSymlMap(block)
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
function nameFromResolutionLocator(resolution: string): string | undefined {
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
  // (e.g. `"@scope/pkg@1.14.1, @scope/pkg@workspace:packages/pkg"`).
  // Per ADR-0016 §B `npm:` is the default protocol — synthesise it so the
  // grammar stays uniform downstream (matches `entryKeyRangeOf`).
  if (colon < 0) {
    return { name, protocol: 'npm', spec: rest }
  }
  return { name, protocol: rest.slice(0, colon), spec: rest.slice(colon + 1) }
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
function workspaceSpecOfEntry(
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
  const self = selfDescriptorOfNode(node)
  const specs = new Set<string>()
  if (self !== undefined) specs.add(self)
  const patchBase = baseSpecOfPatchedNode(node)
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
      const secondary = `${specName}@${entryKeyRangeOf(edge.attrs.range)}`
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
  if (!Array.from(specs).some(spec => spec.startsWith(`${node.name}@`))) {
    specs.add(`${node.name}@npm:${node.version}`)
  }

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
function selfDescriptorOfNode(node: Node): string | undefined {
  if (node.workspacePath !== undefined) {
    return `${node.name}@workspace:${node.workspacePath === '' ? '.' : node.workspacePath}`
  }
  if (node.resolution === undefined) return undefined
  if (node.resolution.startsWith(`${node.name}@patch:`)) return node.resolution
  // A plain `npm:` registry resolution is the resolved version, NOT a key
  // descriptor — exclude it so it is never synthesized into the key.
  if (node.resolution.startsWith(`${node.name}@npm:`)) return undefined
  // Any other locator-shaped resolution (git / file / http / portal / link) IS
  // the exact key descriptor yarn writes for the entry.
  return node.resolution.startsWith(`${node.name}@`) ? node.resolution : undefined
}

function baseSpecOfPatchedNode(node: Node): string | undefined {
  if (node.resolution === undefined || !node.resolution.startsWith(`${node.name}@patch:`)) return undefined
  const locator = patchLocatorOfResolution(node.resolution)
  if (locator === undefined) return undefined
  return baseSpecOfPatchLocator(locator)
}

function baseSpecOfPatchLocator(locator: string): string | undefined {
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
    resolution: resolutionOfNode(node, payload?.resolution, emitDiagnostic),
  }

  // yarn-berry's on-disk format has a single `dependencies:` block per entry —
  // no separate `devDependencies` block. ADR-0019 §C derives `dev` edges at the
  // workspace root from manifests; merge them with `dep` on emit so the
  // classification survives stringify (parse-side will collapse back to `dep`
  // per §C's "no on-lockfile signal" table). F8/#103 — fold any verbatim
  // Rung-4-dropped refs (target absent from the lock) back into the SAME block
  // so a same-format round-trip is byte-faithful (re-sorted by name with the live
  // edges to match yarn's alphabetical block order).
  const dependencies = withUnresolvedDepRefs(
    edgeBlockOfKinds(graph, node, ['dep', 'dev'], config),
    unresolvedDepRefsOfNode(graph, node.id, 'dependencies'),
  )
  if (dependencies !== undefined) entry['dependencies'] = dependencies

  const optionalDependencies = withUnresolvedDepRefs(
    edgeBlockOfKinds(graph, node, ['optional'], config),
    unresolvedDepRefsOfNode(graph, node.id, 'optionalDependencies'),
  )
  if (optionalDependencies !== undefined) entry['optionalDependencies'] = optionalDependencies

  const peerDependencies = extraBlockOfNode(node, 'peerDependencies')
    ?? rawPeerDependenciesBlockOfNode(graph, node.id)
    ?? edgeBlockOfKinds(graph, node, ['peer'], config, { skipMissingRange: true })
  if (peerDependencies !== undefined) entry['peerDependencies'] = peerDependencies

  // Canonical yarn schedule places `dependenciesMeta` BEFORE `peerDependenciesMeta`
  // (verified against real berry locks, e.g. @angular-devkit/build-angular). Both
  // round-trip from the per-node raw sidecar captured at parse, with the legacy
  // node-field hint kept as a fallback for hand-built nodes.
  const dependenciesMeta = rawDependenciesMetaBlockOfNode(graph, node.id)
    ?? extraBlockOfNode(node, 'dependenciesMeta')
  if (dependenciesMeta !== undefined) entry['dependenciesMeta'] = dependenciesMeta

  const peerDependenciesMeta = peerDependenciesMetaOfNode(graph, node)
  if (peerDependenciesMeta !== undefined) entry['peerDependenciesMeta'] = peerDependenciesMeta

  const bin = binBlockOfNode(node, payload)
  if (bin !== undefined) entry['bin'] = bin

  // Trailing-field schedule is FIXED by yarn's emitter and verified byte-for-byte
  // against the real-world berry corpus (v4–v10, ~50k entries, zero inversions):
  //   … bin, checksum, conditions, languageName, linkType
  // (#117). `checksum` precedes `conditions`, which precedes `languageName`, which
  // precedes `linkType`. Any other interleaving breaks byte-fidelity and
  // `yarn install --immutable` on essentially every entry. The blocks above
  // (dependencies, optionalDependencies, peerDependencies, dependenciesMeta,
  // peerDependenciesMeta) keep yarn's `Manifest.exportTo` order; `optionalDependencies`
  // sits between `dependencies` and `peerDependencies` IFF present (yarn folds optional
  // deps into `dependencies` + `dependenciesMeta`, so a real berry lock never carries
  // a separate `optionalDependencies` block — see spec/formats/_common.md §1.4).
  const checksum = checksumOfPayload(payload, config, cacheKey, node.id, emitDiagnostic)
  if (checksum !== undefined) entry['checksum'] = checksum

  // `conditions:` is a SCALAR token (`os=darwin & cpu=arm64`, possibly with
  // `( | )` groups) — emitted verbatim, NOT as a structured block. The captured
  // scalar wins; a string node-field hint is the hand-built fallback. The syml
  // writer would quote it (spaces/`&`), so `stringifyFamily` post-unquotes the
  // `conditions:` lines to match yarn's bare emit (corrects ADR-0018 §A.v5).
  const conditions = rawConditionsScalarOfNode(graph, node.id) ?? scalarConditionsHintOfNode(node)
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
  entry['linkType'] = node.workspacePath !== undefined ? 'soft' : 'hard'

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

function resolutionOfNode(
  node: Node,
  canonical: ResolutionCanonical | undefined,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): string {
  if (node.patch !== undefined) {
    // Intra-family path: parse-side carries the verbatim `@patch:` locator
    // on `node.resolution`. If it survived to emit, stringify it directly —
    // patch identity round-trips losslessly regardless of whether `node.patch`
    // is canonical (128-hex sha512) or sentinel (`unresolved-<sha256>`).
    if (node.resolution !== undefined && patchLocatorOfResolution(node.resolution) !== undefined) {
      return node.resolution
    }
    // Local-artefact locator-disambiguator path: the patch slot is a sentinel
    // keyed off the locator string (parse-side disambiguation per ADR-0011),
    // NOT a real patch — covers `link:` / `portal:` references AND a
    // `::locator=`-qualified `file:` local-tarball alias (Bug #76). The
    // verbatim resolution carries the locator + `::locator=` qualifier intact,
    // so round-trip is lossless — no `RECIPE_FEATURE_DROPPED` to emit.
    if (node.resolution !== undefined && isLocalLocatorDisambiguatedResolution(node.resolution, node.name)) {
      return node.resolution
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
  if (node.resolution !== undefined) return node.resolution
  if (node.workspacePath !== undefined) {
    return `${node.name}@workspace:${node.workspacePath === '' ? '.' : node.workspacePath}`
  }
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
  const seen = new Set<string>()

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
    if (seen.has(depName)) {
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: `cannot emit duplicate ${edge.kind} dependency key ${depName} from ${node.id}`,
      })
    }
    seen.add(depName)
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
  if (config.rangeEmit !== 'bare') return range
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
function peerDependenciesMetaOfNode(graph: Graph, node: Node): SymlMap | undefined {
  const optionalPeers = new Set<string>()
  for (const edge of graph.out(node.id, 'peer')) {
    if (edge.attrs?.optional !== true) continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    optionalPeers.add(edge.attrs.alias ?? dst.name)
  }

  // Verbatim hint: sidecar (real-lock round-trip) preferred over the node field.
  // Carried through to emit so any NON-`optional` key yarn might write (today it
  // only writes `optional`) survives unmodelled, per task #89's preserve-via-
  // sidecar requirement.
  const hint = rawPeerDependenciesMetaBlockOfNode(graph, node.id)
    ?? extraBlockOfNode(node, 'peerDependenciesMeta')
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

function binBlockOfNode(node: Node, payload: TarballPayload | undefined): SymlMap | undefined {
  if (payload?.bin === undefined) return undefined
  if (typeof payload.bin === 'string') {
    return { [node.name]: payload.bin }
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

function patchLocatorOfResolution(resolution: string): string | undefined {
  if (resolution.startsWith('patch:')) return resolution
  const idx = resolution.indexOf('@patch:')
  return idx >= 0 ? resolution.slice(idx + 1) : undefined
}

function patchSourceOfLocator(locator: string): string | undefined {
  const hashIdx = locator.indexOf('#')
  if (hashIdx < 0) return undefined
  const paramsIdx = locator.indexOf('::', hashIdx + 1)
  const source = paramsIdx < 0
    ? locator.slice(hashIdx + 1)
    : locator.slice(hashIdx + 1, paramsIdx)
  return isDegeneratePatchSource(source) ? undefined : source
}

function isDegeneratePatchSource(source: string): boolean {
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
function irreducibleCollisionMessage(
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

  let hint = 'likely npm: alias, patch: collision, or workspace link: locator collision'
  if (isLink(currentResolution) || isLink(priorResolution)) {
    hint = 'likely workspace link: / portal: locator collision (yarn `::locator=` qualifier was lost)'
  } else if (isPatch(currentResolution) || isPatch(priorResolution)) {
    hint = 'likely patch: collision'
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

function sortPeerContext(peers: readonly string[]): string[] {
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
      const nextId = serializeNodeId(node.name, node.version, peerContext, node.patch)
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
 * `workspace:<spec>` range от disk as the source-side specifier;
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
function isRegistryRange(range: string): boolean {
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
        refs.push({
          block: kind === 'optional' ? 'optionalDependencies' : 'dependencies',
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
  return hasExplicitProtocol(range) ? range : `npm:${range}`
}

// Bug #104 — project a bound NodeId to its bare `${name}@${version}` key for the
// patch-sibling index lookup, stripping a peerContext `(...)` tail and a
// `+<slot>=…` disambiguator suffix. At parse time a Rung-0/3-bound base id is
// already bare (peerContext is empty pre-enrich, a registry base carries no patch
// slot), so this is identity in the common path; the strips are defensive for a
// form-a Rung-0 bind onto a patch node (whose `+patch=` suffix is removed so the
// lookup keys off the shared base `name@version`). `nameOf` is peerContext-depth-
// aware; the version is the segment after the last depth-0 `@`, minus any `+slot`.
function nodeNameVersion(id: string): string | undefined {
  const name = nameOf(id)
  if (name.length >= id.length) return undefined
  let rest = id.slice(name.length + 1) // drop `name@`
  const parenIdx = rest.indexOf('(') // peerContext tail
  if (parenIdx >= 0) rest = rest.slice(0, parenIdx)
  const plusIdx = rest.indexOf('+') // TarballKey-style disambiguator slot
  if (plusIdx >= 0) rest = rest.slice(0, plusIdx)
  return rest.length > 0 ? `${name}@${rest}` : undefined
}

function hasExplicitProtocol(range: string): boolean {
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
function strippedPatchDescriptor(lookup: string): string | undefined {
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
function locatorQualifierOfPatchSpec(spec: string): string | undefined {
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
