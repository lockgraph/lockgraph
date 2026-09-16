# API reference

| Name | Operates on | Summary |
|---|---|---|
| [`detect`](#detect) | lockfile | Identify a lockfile's format. |
| [`check`](#check) | lockfile | Test bytes against one format. |
| [`parse`](#parse) | lockfile → graph | Read a lockfile into a graph. |
| [`stringify`](#stringify) | graph → lockfile | Emit a graph for a target format. |
| [`convert`](#convert) | lockfile → lockfile | Parse, enrich and emit in one call. |
| [`modify`](#modify) | graph | Apply edits and report the frontier. |
| [`overrideSource`](#overridesource) | lockfile → lockfile | Rewrite recorded source locators in place. |
| [`assertSource`](#assertsource) | lockfile | Check that packages resolve from allowed sources. |
| [`parseSourceRule`](#parsesourcerule) | rule string | Validate one source rule. |
| [`complete`](#complete) | graph | Resolve and wire what a change introduced. |
| [`removeUnreachable`](#removeunreachable) | graph | Sweep nodes unreachable from the workspaces. |
| [`selectConstrained`](#selectconstrained) | registry | Pick a version satisfying range and conditions. |
| [`enrich`](#enrich) | graph | Fill everything the target format requires. |
| [`refurbish`](#refurbish) | graph payloads | Repair payload fields in the lock's own format. |
| [`prepareFrozen`](#preparefrozen) | lockfile → candidate | Build a candidate for a pinned manager version. |
| [`certifyFrozen`](#certifyfrozen) | candidate + files | Bind a manager run to that candidate. |
| [`liveRegistry`](#liveregistry) | — | Network-backed registry adapter. |
| [`frozenRegistry`](#frozenregistry) | graph | Registry adapter backed by the graph. |
| [`resolveRegistry`](#resolveregistry) | — | Resolve registry config from the project. |
| [`defaultFetch`](#defaultfetch) | — | Default transport. |
| [`lockgraphStore`](#lockgraphstore) | — | Construct a verified-byte store. |
| [`engines`](#engines) | — | Condition on a candidate's `engines`. |
| [`license`](#license) | — | Condition on a candidate's licence. |
| [`LockfileError`](#lockfileerror) | — | The error type for domain failures. |

Shared shapes: [common options](#common-options) · [target](#target) ·
[sources](#sources) · [guards](#guards) · [store](#store) · [contracts](#contracts)

---

## detect

<!-- readme-example id="api-sig-detect" mode="signature" -->
```ts
function detect(input: string): FormatId | undefined
```

Identifies a lockfile's format from its bytes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `input` | `string` | yes | Lockfile text. |

**Returns** `FormatId`, or `undefined` when no format matches.

**Throws** nothing.

<!-- readme-example id="api-detect" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { detect } from 'lockgraph'

detect(await readFile('pnpm-lock.yaml', 'utf8'))   // 'pnpm-v9'
detect('not a lockfile')                           // undefined
```

## check

<!-- readme-example id="api-sig-check" mode="signature" -->
```ts
function check(input: string, format: FormatId): boolean
```

Tests whether bytes are a specific format.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `input` | `string` | yes | Lockfile text. |
| `format` | `FormatId` | yes | Format to test against. |

**Returns** `boolean`.

**Throws** nothing.

## parse

<!-- readme-example id="api-sig-parse" mode="signature" -->
```ts
function parse(input: string, format?: FormatId, options?: ParseOptions): Graph
```

Reads a lockfile into a `Graph`. Synchronous; performs no network access. Reads
workspace and override material from the project, controlled by `cwd` and
`sources.policy`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `input` | `string` | yes | | Lockfile text. |
| `format` | `FormatId` | no | detected | Source format. |
| `options.cwd` | `string` | no | `process.cwd()` | Discovery start for workspace and policy material, and for the registry the project's own configuration declares. |
| `options.registry` | `string` | no | | The registry a lock does not record. Absolute `http(s)`, no query, fragment or credentials. |
| `options.sources.policy` | `PmConfigEvidence` | no | discovered | Package-manager configuration evidence. |
| `options.onDiagnostic` | `DiagnosticObserver` | no | | Non-fatal findings, in emission order. |

**An unrecorded registry stays unknown.** npm and yarn-classic write an absolute URL for every
entry; pnpm and deno write one only for a non-default registry, and yarn berry and bun write none —
for those the registry lives in `.npmrc`, `.yarnrc.yml` or `bunfig.toml`, which the lock does not
carry. Such a package parses to `{ kind: 'registry' }` — a registry package whose host is
undetermined — and no public default is substituted. Pass `registry`, or `cwd` so the project's own
configuration can be read, to determine it. A target that cannot express an undetermined host says
so: npm omits `resolved`, pnpm keeps the integrity-only spelling, berry writes the plain `npm:`
locator, and yarn-classic refuses, naming the package and the two options.

**Returns** `Graph`.

**Throws** `LockfileError` — `PARSE_FAILED`, `FORMAT_DETECT_FAILED`, `FORMAT_MISMATCH`.

<!-- readme-example id="api-parse" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { parse } from 'lockgraph'

const graph = parse(await readFile('pnpm-lock.yaml', 'utf8'))
graph.roots()                 // workspace node ids
graph.byName('lodash')        // every lodash node id
graph.overrides()             // overrides the lock pins
graph.diagnostics()           // findings from parsing
```

## stringify

<!-- readme-example id="api-sig-stringify" mode="signature" -->
```ts
function stringify(graph: Graph, target: TargetInput, options?: StringifyOptions): string
```

Emits a graph as a lockfile. `target` is required: a graph does not imply a format.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `graph` | `Graph` | yes | | Graph to emit. |
| `target` | `TargetInput` | yes | | See [target](#target). |
| `options.strict` | `boolean` | no | `true` | `false` emits despite projection loss and reports it. |
| `options.lineEnding` | `'lf' \| 'crlf'` | no | source | Line endings. |
| `options.sources.policy` | `PmConfigEvidence` | no | discovered | Configuration evidence. |
| `options.onDiagnostic` | `DiagnosticObserver` | no | | Non-fatal findings. |

**Returns** `string`.

**Throws** `LockfileError` — `ENRICH_REQUIRED` when the target needs material the
graph does not carry; `IRREDUCIBLE_LOSS` under `strict`.

## convert

<!-- readme-example id="api-sig-convert" mode="signature" -->
```ts
function convert(input: string, options: ConvertOptions): Promise<string>
function convert(input: Graph, options: ConvertOptions): Promise<string>
function convert(input: FileSource, options: ProjectConvertOptions): Promise<ProjectOutput>
```

`parse` + `enrich` + `stringify`. Asynchronous because filling gaps may read
manifests, a registry or cached archives.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `input` | `string \| Graph \| FileSource` | yes | | Lockfile text, a graph, or the project's files. |
| `options.sourceFormat` | `FormatId` | no | detected | Source format. |
| `options.contract` | `ConversionContract` | no | `'snapshot'` | See [contracts](#contracts). |
| `options.strict` | `boolean` | no | `true` | As `stringify`. |
| `options.lineEnding` | `'lf' \| 'crlf'` | no | source | Line endings. |
| `options.evidence` | `ProjectEvidenceInput[]` | no | discovered | Pre-read project evidence. |
| `options.fs` | `ConvertFileSystem` | no | node fs | Filesystem for the project form. |

Plus [common options](#common-options).

**Returns** `Promise<string>`; `Promise<ProjectOutput>` for a `FileSource` input.

**Throws** `LockfileError` — `ENRICH_REQUIRED`, `IRREDUCIBLE_LOSS`, `CAPABILITY_LACK`,
`INVALID_INPUT`.

<!-- readme-example id="api-convert" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { convert } from 'lockgraph'

await convert(await readFile('pnpm-lock.yaml', 'utf8'), { target: 'npm-3' })

await convert(await readFile('yarn.lock', 'utf8'), {
  target: 'yarn-berry-v10',
  sources: { artifacts: ['yarn-berry:.yarn/cache', 'npm'] },
})
```

### Project form

`convert(FileSource, ProjectConvertOptions)` returns `{ lockfile, companions }`.
Companions are the other files the target manager needs changed with the lock; the
set depends on the format pair and is computed per conversion.

| Field | Difference from `ConvertOptions` |
|---|---|
| `contract` | only `'install'` |
| `sources.manifests` | absent — the project input is the manifest authority |

Coverage is derived from the root manifest and the workspace topology it declares. A
manifest set that does not cover the discovered workspaces produces a diagnostic.

## modify

<!-- readme-example id="api-sig-modify" mode="signature" -->
```ts
function modify(
  graph: Graph,
  change: Modification | readonly Modification[],
  options: ModifyOptions,
): Promise<ModifyResult>
```

Applies edits to a graph. A list is applied in order; diagnostics and frontier state
are collected once for the whole batch.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `graph` | `Graph` | yes | Graph to edit. |
| `change` | `Modification \| Modification[]` | yes | One edit or an ordered batch. |
| `options` | `ModifyOptions` | yes | [common options](#common-options). |

**`Modification` variants**

| `kind` | Fields |
|---|---|
| `replaceVersion` | `selector: ReplaceVersionSelector`, `to: string` |
| `pinOverride` | `name: string`, `to: string` |
| `addDependency` | `parent: NodeId`, `name: string`, `range: string`, `edge: EdgeKind` |
| `removeDependency` | `parent: NodeId`, `name: string` |
| `applyPatch` | `ApplyPatchSpec` |
| `filterLicense` | allow / deny sets |

**Returns** `ModifyResult`

| Field | Type | Description |
|---|---|---|
| `graph` | `Graph` | The edited graph. |
| `applied` | `GraphChange[]` | What each edit did. |
| `frontier` | `GraphFrontier` | `{ added, orphaned }` — pass to `complete` as `seed`. |
| `diagnostics` | `Diagnostic[]` | In emission order. |

**Throws** `LockfileError` — `INVALID_INPUT`, `CAPABILITY_LACK`.

<!-- readme-example id="api-modify" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { complete, modify, parse } from 'lockgraph'

const target = 'npm-3'
const graph = parse(await readFile('package-lock.json', 'utf8'))

const bumped = await modify(graph, [
  { kind: 'replaceVersion', selector: { name: 'lodash' }, to: '4.17.21' },
  { kind: 'pinOverride', name: 'minimist', to: '1.2.8' },
], { target })

await complete(bumped.graph, { target, seed: bumped.frontier, pruneOrphans: true })
```

## overrideSource

<!-- readme-example id="api-sig-overridesource" mode="signature" -->
```ts
function overrideSource(
  input: string,
  rules: string | SourceRule | readonly (string | SourceRule)[],
  options?: SourceOperationOptions,
): OverrideSourceResult
```

Rewrites the source locators a lockfile records — for example, moving every package from the
public registry behind an internal repository manager. It edits the text in place: the output is
byte-identical to the input everywhere except the rewritten URLs, so the diff is as small as a text
substitution. It never touches a digest — an integrity hash, the yarn-classic `#<sha1>` fragment, a
git commit id — so if the new source serves different bytes, the install fails its integrity check.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `input` | `string` | yes | Lockfile text. |
| `rules` | `string \| SourceRule \| (string \| SourceRule)[]` | yes | One or more [source rules](#source-rules). |
| `options.format` | `FormatId` | no | Skip detection. |
| `options.allowEmptyRules` | `boolean` | no | Accept a rule that matches nothing. Off by default, because an empty migration looks like a successful one. |

**Returns** `OverrideSourceResult` — `result.output` (the rewritten text), `result.ok`, and every
entry it considered, itemized in `result.items` and totalled in `result.counts` by
[status](#source-statuses). `result.ok` is false if any status is `'unguarded'`, `'unrewritable'` or
`'unmatched'`.

Supported: npm-\*, yarn-classic, pnpm (explicit `resolution.tarball` locators), deno (explicit
`npm.*.tarball`).
Yarn berry and bun are refused: they record no locator for a registry package, whose registry
comes from `.yarnrc.yml`, or from `.npmrc` / `bunfig.toml`.

**Throws** `LockfileError` — `CAPABILITY_LACK` (unsupported format), `FORMAT_DETECT_FAILED`;
`TypeError` for a malformed rule.

<!-- readme-example id="api-overridesource" mode="typecheck" -->
```ts
import { readFile, writeFile } from 'node:fs/promises'
import { overrideSource } from 'lockgraph'

const input = await readFile('package-lock.json', 'utf8')
const result = overrideSource(input, [
  'https://registry.npmjs.org=https://nexus.example.com/repository/npm-group/',
  'https://registry.yarnpkg.com=https://nexus.example.com/repository/npm-group/',
  'npm:@corp/*=https://nexus.example.com/repository/internal/',
])
if (!result.ok) console.error(result.counts)
else await writeFile('package-lock.json', result.output)
```

## assertSource

<!-- readme-example id="api-sig-assertsource" mode="signature" -->
```ts
function assertSource(
  input: string,
  rules: string | SourceRule | readonly (string | SourceRule)[],
  options?: SourceOperationOptions,
): AssertSourceResult
```

Checks that the packages a rule selects already resolve from its destination, and changes nothing.
Use it in CI to keep packages that must stay on an internal repository from resolving anywhere else,
whatever the registry configuration says. Each selected entry's status is `'compliant'`,
`'violation'`, or `'uncertifiable'` — the lock does not record where it comes from, so it cannot be
checked. `result.ok` is false on any `'violation'`, `'uncertifiable'` or `'unmatched'`: a policy that
cannot be evaluated does not hold.

Parameters, supported formats and throws are those of [`overrideSource`](#overridesource).

<!-- readme-example id="api-assertsource" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { assertSource } from 'lockgraph'

const result = assertSource(
  await readFile('package-lock.json', 'utf8'),
  'npm:@corp/*=https://nexus.example.com/repository/internal/',
)
for (const item of result.items) {
  if (item.status === 'violation') console.error(`${item.packageName} resolves from ${item.locator}`)
}
if (!result.ok) process.exitCode = 1
```

## parseSourceRule

<!-- readme-example id="api-sig-parsesourcerule" mode="signature" -->
```ts
function parseSourceRule(raw: string): SourceRule
```

Validates one rule and returns its normalized form, for tools that accept rules from a command line
before running either operation. **Throws** `TypeError` for a malformed rule.

### Source rules

A rule is `<selector>=<destination>`. Always quote rules on a command line.

A selector is either a **pattern**, which understands its protocol, or a **URL**, which is taken
literally:

| Selector | Selects | Rewrites |
|---|---|---|
| `npm:*` | every npm package | the registry base, keeping `<name>/-/<file>` |
| `npm:@scope/*` | packages in that scope | the registry base |
| `npm:<name>`, `npm:@scope/<name>` | one package | the registry base |
| `git:<host>/<owner>/*` | that owner's repositories, over any transport | host and owner |
| `git:<host>/<owner>/<repo>` | one repository, over any transport | host, owner and repository |
| `<scheme>://<host>[/<path>]` | every recorded URL, npm or git, that starts with exactly this | exactly this prefix |

Package patterns match the resolved package, never an alias key. A URL is literal, scheme included:
`https://registry.npmjs.org` does not select `http://registry.npmjs.org/...`, so a lock that records
both declares both.

- **Precedence:** a package, then a scope, then a location — `git:` patterns and URLs together, the
  longer one first — then `npm:*`. Two rules equally specific for one entry are refused, not ordered:
  write a more specific rule. A rule whose destination another rule would match is refused.
- The destination is an absolute URL with a scheme. Credentials, a query, a fragment and a downgrade
  from `https:` to `http:` are refused.
- `git:*` is refused: a repository path is not unique across hosts, so one destination would merge
  distinct repositories. `npm:@scope` without `/*` or a name is refused.
- `npm:*` selects every npm package, including one whose lock records no URL — that one is reported
  (`'unrewritable'`, `'uncertifiable'`), never skipped. A URL rule selects only recorded URLs.

### Source statuses

| Status | Operation | Meaning | Fails `ok` |
|---|---|---|---|
| `rewritten` | override | Locator moved to the destination. | no |
| `compliant` | both | Already at the destination, with a digest. | no |
| `violation` | assert | Resolves from a source outside the rule. | yes |
| `uncertifiable` | assert | No recorded locator, or no digest on an allowed one. | yes |
| `unguarded` | override | Matched, but no digest pins its bytes — left unchanged. | yes |
| `unrewritable` | override | A registry entry whose lock omits the locator — change the registry setting instead. | yes |
| `local` | both | No remote source of its own: bundled, a workspace, `file:`, `link:`, a directory. | no |
| `unmatched` | both | A rule that selected nothing. | yes |

---

## complete

<!-- readme-example id="api-sig-complete" mode="signature" -->
```ts
function complete(graph: Graph, options: CompleteOptions): Promise<CompleteResult>
```

Resolves the transitive dependencies a change introduced, wires their edges, and
optionally retires what it stranded.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `graph` | `Graph` | yes | | Graph to settle. |
| `options.seed` | `GraphFrontier` | no | whole graph | Bounds the pass to one change's delta. Normally `modify(...).frontier`. |
| `options.pruneOrphans` | `boolean` | no | `false` | Retire nodes the seeded change left with no incoming edge. |
| `options.resolution` | `'highest' \| 'prefer-existing'` | no | `'highest'` | `'prefer-existing'` reuses versions already in the lock. |
| `options.overrides` | `OverrideConstraint[]` | no | declared | Overrides the result must honour. |
| `options.constraints` | `Condition[]` | no | | See [`engines`](#engines), [`license`](#license). |
| `options.onUnevaluable` | `OnUnevaluable` | no | | Behaviour when a condition cannot be decided. |
| `options.budget` | `CompletionBudget` | no | | Bounds resolution work. |

Plus [common options](#common-options).

**Returns** `CompleteResult` — `{ graph, added: NodeId[], wired: EdgeTriple[], removed: NodeId[], diagnostics }`.

**Throws** `LockfileError` — `COMPLETION_FAILED`, `INVALID_INPUT`.

## removeUnreachable

<!-- readme-example id="api-sig-removeunreachable" mode="signature" -->
```ts
function removeUnreachable(
  graph: Graph,
  options?: RemoveUnreachableOptions,
): RemoveUnreachableResult
```

Mark-and-sweep from the workspaces. Synchronous, deterministic, idempotent. Refuses a
graph with no workspace anchor rather than removing everything.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `graph` | `Graph` | yes | Graph to sweep. |
| `options.preserve` | `ReadonlySet<NodeId>` | no | Nodes to keep regardless of reachability. |
| `options.onDiagnostic` | `DiagnosticObserver` | no | Non-fatal findings. |

**Returns** `RemoveUnreachableResult` — `{ graph, removed: NodeId[], diagnostics }`.
`removed` is content-sorted.

**Throws** nothing; a rootless graph is reported as a diagnostic.

## selectConstrained

<!-- readme-example id="api-sig-selectconstrained" mode="signature" -->
```ts
function selectConstrained(
  name: string,
  range: string,
  options: SelectConstrainedOptions,
): Promise<SelectConstrainedResult>
```

Picks the version of a package satisfying both a range and a set of conditions. Works
against registry metadata; takes no graph.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Package name. |
| `range` | `string` | yes | Semver range. |
| `options.registry` | `RegistryAdapter` | yes | Metadata source. |
| `options.conditions` | `Condition[]` | yes | Every candidate must pass all of them. |
| `options.onUnevaluable` | `OnUnevaluable` | no | Behaviour when a condition cannot be decided. |

**Returns** `SelectConstrainedResult`

| Field | Type | Description |
|---|---|---|
| `selected` | `PackumentVersion \| undefined` | The chosen version, if any. |
| `rejected` | `RejectedCandidate[]` | `{ name, version, condition, reason? }` per refusal. |

**Throws** `LockfileError` — `REGISTRY_UNAVAILABLE`.

## enrich

<!-- readme-example id="api-sig-enrich" mode="signature" -->
```ts
function enrich(graph: Graph, options: EnrichOptions): Promise<EnrichResult>
```

Completes the graph and materialises what the target manager expects, including
overlays whose order matters.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `graph` | `Graph` | yes | | Graph to enrich. |
| `options.contract` | `ConversionContract` | no | `'snapshot'` | See [contracts](#contracts). |

Plus [common options](#common-options).

**Returns** `EnrichResult` — `{ graph, diagnostics }`.

**Throws** `LockfileError` — `ENRICH_REQUIRED`, `CAPABILITY_LACK`, `INVALID_INPUT`.

## refurbish

<!-- readme-example id="api-sig-refurbish" mode="signature" -->
```ts
function refurbish(
  graph: Graph,
  format: FormatId,
  source: RefurbishSources | TarballSource,
  options?: RefurbishOptions,
): Promise<RefurbishResult>
```

Repairs payload fields on nodes that already exist, in the graph's **own** format.
It does not complete, does not materialize, and does not project.

That is the whole distinction from its neighbours. `enrich` is the projection verb —
*make this graph satisfy that target*. `refurbish` is the repair verb — *I changed
this graph by hand; refill what can be refilled, in the format it came from*. Which
is why it takes no target, and why it can be scoped: repair is naturally partial,
projection is naturally whole-graph.

| | [`complete`](#complete) | `refurbish` |
|---|---|---|
| changes | graph **structure** — adds nodes, wires edges | **payload fields** on nodes that already exist |
| needs | packuments (metadata) | artifact **bytes** |
| format argument | a target to project onto | the lock's **own** format, repaired in place |

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `graph` | `Graph` | yes | | Graph whose payloads are repaired. |
| `format` | `FormatId` | yes | | The lock's own format — not a target. `detect()` returns one. |
| `source` | `RefurbishSources \| TarballSource` | yes | | Where bytes and checksums come from. |
| `options.seed` | `ReadonlySet<NodeId>` | no | every non-workspace node | Bound the fill to these nodes. |
| `options.concurrency` | `number` | no | `16` | Concurrent fills. |
| `options.cacheKey` | `string` | no | inferred | Berry cache key to fill for. |
| `options.cacheKeyInference` | `'format-default' \| 'observed-only'` | no | | How a missing cache key is chosen. |
| `options.artifactResources` | `ArtifactResourcePolicy` | no | | Byte ceilings; see [guards](#guards). |
| `options.onDiagnostic` | `DiagnosticObserver` | no | | Non-fatal findings. |

**Returns** `RefurbishResult` — `{ graph, enriched, unresolved }`. The second field
names the nodes actually filled; the third carries what could not be. That last name
is deliberately not `diagnostics`: this is not one of the operations, and consumers
depend on the distinction.

Two boundaries worth knowing before you call it:

- **A bare-era Berry lock needs an explicit cache key.** Wire versions v4–v7 carry no
  per-entry prefix to infer from, so without `options.cacheKey` every gap defers
  rather than filling. Prefix-era locks (v8 and later) can infer it — see
  [Berry cache keys](#berry-cache-keys) and
  [within one family](./CONVERT.md#within-one-family).
- **`TarballSource.berryChecksum` is an optional fast path.** Yarn Berry stores its
  repacked zip with the digest in the filename, so returning it skips both the fetch
  and the recompute. It is purely additive: return `undefined` and the normal
  fetch-and-recompute path runs.

## prepareFrozen

<!-- readme-example id="api-sig-preparefrozen" mode="signature" -->
```ts
function prepareFrozen(input: string | Graph, options: FrozenOptions): Promise<FrozenPreparationResult>
function prepareFrozen(input: FileSource, options: ProjectFrozenOptions): Promise<FrozenPreparationResult>
```

Builds a candidate a pinned manager version should accept without rewriting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `input` | `string \| Graph \| FileSource` | yes | Lockfile text, a graph, or the project's files. |
| `options.target` | `PinnedTargetRequest` | yes | `managerVersion` is **required** here. |
| `options.sourceFormat` | `FormatId` | no | Source format. |
| `options.evidence` | `ProjectEvidenceInput[]` | no | Pre-read project evidence. |
| `options.fs` | `ConvertFileSystem` | no | Filesystem implementation. |
| `options.lineEnding` | `'lf' \| 'crlf'` | no | Line endings. |

Plus [common options](#common-options) except `strict`.

**Returns** `FrozenPreparationResult`

| Field | Type | Description |
|---|---|---|
| `candidate` | `FrozenCandidate` | `{ lockfile, companions }` plus its verification subject. |
| `assessment` | `ConversionAssessment` | Per-requirement status. `unassessed` means unchecked, not failed. |
| `diagnostics` | `Diagnostic[]` | In emission order. |

**Throws** `LockfileError` — `ENRICH_REQUIRED`, `INVALID_INPUT`.

## certifyFrozen

<!-- readme-example id="api-sig-certifyfrozen" mode="signature" -->
```ts
function certifyFrozen(
  candidate: FrozenCandidate,
  options: FrozenCertificationOptions,
): Promise<FrozenConversionResult>
```

Binds a real manager run to the candidate that produced it. The caller runs the
manager; core never shells out.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `candidate` | `FrozenCandidate` | yes | | From `prepareFrozen`. |
| `options.files` | `FileSource` | yes | | Post-run files: paths or globs relative to `cwd`, or a content map. |
| `options.manager` | `PackageManager` | yes | | Which manager actually ran. `'lockgraph'` is not accepted. |
| `options.version` | `string` | yes | | That manager's real `--version` output. |
| `options.platform` | `string` | no | `process.platform` | Platform the run happened on. |
| `options.cwd` | `string` | no | `process.cwd()` | Where to read `files` from. |
| `options.fs` | `ConvertFileSystem` | no | node fs | Filesystem implementation. |

**Returns** `FrozenConversionResult` — `{ lockfile, companions, verification, assessment, diagnostics }`.

**Throws** `LockfileError` when the candidate is stale, copied, or belongs to a
different target, manager, version or platform.

The bound hashes give integrity, not authenticity: they prevent a receipt being
reused for another projection; they cannot prove an untrusted party ran the manager.

<!-- readme-example id="api-frozen" mode="typecheck" -->
```ts
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { certifyFrozen, prepareFrozen } from 'lockgraph'

const run = promisify(execFile)
const cwd = process.cwd()
const { stdout } = await run('npm', ['--version'], { cwd })
const version = stdout.trim()

const { candidate } = await prepareFrozen(['package.json', 'package-lock.json'], {
  target: { format: 'npm-3', managerVersion: version },
  cwd,
})
await writeFile('package-lock.json', candidate.lockfile)
for (const file of candidate.companions) await writeFile(file.path, file.content)

await run('npm', ['ci', '--ignore-scripts'], { cwd })

const certified = await certifyFrozen(candidate, {
  files: ['package-lock.json'],
  cwd,
  manager: 'npm',
  version,
})
console.log(certified.verification)
```

## liveRegistry

<!-- readme-example id="api-sig-liveregistry" mode="signature" -->
```ts
function liveRegistry(options?: LiveRegistryOptions): LiveRegistryAdapter
```

Constructs a network-backed registry adapter. The only byte-capable source: place it
in `sources.artifacts` for remote bytes; omit it and the operation is offline.

`LiveRegistryOptions` is one of two mutually exclusive shapes, plus transport fields
available to both.

| Shape | Fields |
|---|---|
| discovery | `cwd` (required), `config: RegistryConfigDialect` (required), `registry?`, `env?`, `home?` |
| supplied config | `config: RegistryConfig` — you answer the routing questions yourself |
| direct | `url?`, `authHeader?` |
| any of them | `fetch?`, `limit?` |

<!-- readme-example id="api-sig-registryconfig" mode="signature" -->
```ts
interface RegistryConfig {
  registryFor(packageName: string): string
  authHeaderFor(registryUrl: string): string | undefined
}
```

`authHeaderFor` is asked for credentials for a **registry root**, not for an arbitrary
URL. The adapter confines what you return to that route, revalidating every request
and every redirect hop; credentials are never forwarded to a different origin or path
prefix. Getting the binding right is the library's job, not the caller's.

| Field | Type | Description |
|---|---|---|
| `cwd` | `string` | Project root to read configuration from. |
| `config` | `RegistryConfigDialect \| RegistryConfig` | A dialect name to discover routing, or an object that supplies it. |
| `registry` | `string` | Override the resolved registry URL. |
| `env` | `Record<string, string \| undefined>` | Environment used for resolution. |
| `home` | `string` | Home directory used for resolution. |
| `url` | `string` | Registry URL, supplied directly. |
| `authHeader` | `string` | Authorization header, supplied directly. |
| `fetch` | `Fetch` | Transport. Defaults to [`defaultFetch`](#defaultfetch). |
| `limit` | `Limiter` | Concurrency and rate control. |

**Returns** `LiveRegistryAdapter`.

**Throws** `LockfileError` — `INVALID_INPUT` when the shapes are mixed.

A URL is requested only when it lies inside that package's configured route or is
attested by exact name-and-version metadata. Redirects are followed manually and
re-authorized per hop; credentials attach only after route authorization.

## frozenRegistry

<!-- readme-example id="api-sig-frozenregistry" mode="signature" -->
```ts
function frozenRegistry(graph: Graph): RegistryAdapter
```

Constructs a registry adapter answering only from what the graph already records.
Performs no network access.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `graph` | `Graph` | yes | Source of recorded evidence. |

**Returns** `RegistryAdapter`.

**Throws** nothing.

## resolveRegistry

<!-- readme-example id="api-sig-resolveregistry" mode="signature" -->
```ts
function resolveRegistry(cwd: string, options: ResolveRegistryOptions): RegistryConfig
```

Resolves registry URL, scope, auth and host binding from the package manager's own
configuration. Use it when the resolved values are wanted rather than an adapter.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cwd` | `string` | yes | Project root. |
| `options.config` | `RegistryConfigDialect` | yes | Configuration grammar to read. |
| `options.registry` | `string` | no | Override the resolved URL. |
| `options.env` | `Record<string, string \| undefined>` | no | Environment to resolve from. |
| `options.home` | `string` | no | Home directory to resolve from. |

**Returns** `RegistryConfig`.

**Throws** `LockfileError` — `INVALID_INPUT`.

## defaultFetch

<!-- readme-example id="api-sig-defaultfetch" mode="signature" -->
```ts
const defaultFetch: Fetch
```

The transport used when none is supplied. Exported so a custom `fetch` can wrap it
rather than reimplement it.

## lockgraphStore

<!-- readme-example id="api-sig-lockgraphstore" mode="signature" -->
```ts
function lockgraphStore(path?: string, options?: { maxBytes?: ByteSize }): Store
```

Constructs a verified-byte store for an operation to use in place of the global one.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | no | global location | Store root. |
| `options.maxBytes` | `ByteSize` | no | `'5 GiB'` | Capacity. Eviction is always enforced. |

**Returns** `Store`.

**Throws** `LockfileError` — `INVALID_INPUT` on a non-positive capacity.

Behaviour is described under [store](#store).

## engines

<!-- readme-example id="api-sig-engines" mode="signature" -->
```ts
function engines(
  required: Record<string, string>,
  options?: { mode?: 'lenient' | 'strict' },
): Condition
```

A condition accepting a candidate only when its `engines` field is compatible with
what is required.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `required` | `Record<string, string>` | yes | | Engine name to semver range. |
| `options.mode` | `'lenient' \| 'strict'` | no | `'lenient'` | `'lenient'` admits candidates declaring nothing; `'strict'` refuses them. |

**Returns** `Condition`.

## license

<!-- readme-example id="api-sig-license" mode="signature" -->
```ts
function license(options: { allow?: readonly string[]; deny?: readonly string[] }): Condition
```

A condition filtering candidates by licence identifier.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `options.allow` | `string[]` | no | Only these identifiers pass. |
| `options.deny` | `string[]` | no | These identifiers are refused. |

**Returns** `Condition`.

<!-- readme-example id="api-conditions" mode="typecheck" -->
```ts
import { engines, license, liveRegistry, selectConstrained } from 'lockgraph'

const { selected, rejected } = await selectConstrained('lodash', '^4', {
  registry: liveRegistry({ cwd: process.cwd(), config: 'npm' }),
  conditions: [
    engines({ node: '>=18' }, { mode: 'strict' }),
    license({ deny: ['GPL-3.0-only'] }),
  ],
})
for (const candidate of rejected) console.warn(candidate.version, candidate.condition)
```

## LockfileError

<!-- readme-example id="api-sig-lockfileerror" mode="signature" -->
```ts
class LockfileError extends Error {
  readonly code: LockfileErrorCode
  readonly diagnostics: readonly Diagnostic[]
  readonly losses?: readonly ProjectionLoss[]
  readonly cause?: unknown

  constructor(options: {
    code: LockfileErrorCode
    message?: string
    cause?: unknown
    diagnostics?: readonly Diagnostic[]
    losses?: readonly ProjectionLoss[]
  })
}
```

The type every domain failure throws. A malformed argument — an invalid source rule, a byte size
that does not parse — throws a `TypeError` instead.

| Property | Type | Description |
|---|---|---|
| `code` | `LockfileErrorCode` | Names the cause. Catalogued in [ERRORS.md](./ERRORS.md). |
| `diagnostics` | `Diagnostic[]` | Everything the operation had emitted when it failed. |
| `losses` | `ProjectionLoss[]` | Present on projection failures: what could not survive, and the remedy that would admit it. |
| `cause` | `unknown` | Underlying error, when there is one. |

`onDiagnostic` receives non-fatal findings only; fatal ones ride the throw.

---

# Shared shapes

## Common options

Taken by `convert`, `enrich`, `modify`, `complete`, `prepareFrozen` and
`certifyFrozen`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | `TargetInput` | yes | | See [target](#target). |
| `sources` | `OperationSources` | no | discovered | See [sources](#sources). |
| `cwd` | `string` | no | `process.cwd()` | Discovery start. The project root is found by walking upward; with no project marker, `cwd` is the root. |
| `guards` | `GuardProfile[]` | no | defaults | See [guards](#guards). |
| `store` | `Store \| false` | no | global store | See [store](#store). |
| `onDiagnostic` | `DiagnosticObserver` | no | | Called in emission order; the return value is ignored. |

Every operation returns at least `diagnostics`; graph operations also return `graph`.

## target

<!-- readme-example id="api-sig-targetinput" mode="signature" -->
```ts
type TargetInput = FormatId | TargetRequest
```

| Field | Type | Required | Description |
|---|---|---|---|
| `format` | `FormatId` | yes | Target format. |
| `managerVersion` | `string` | no | Pins the manager version. Required by `prepareFrozen`. |
| `cacheKey` | `string` | no | **Yarn Berry targets only.** Set when project compression configuration changes the target cache key. |

A bare `FormatId` pins the format and lets the manager version float.

## sources

| Field | Type | Authority granted |
|---|---|---|
| `manifests` | `FileSource` | The operation's sole project-manifest authority. Coverage is derived from the root manifest and discovered workspace topology. |
| `policy` | `PmConfigEvidence` | Package-manager configuration. |
| `packuments` | `RegistryAdapter[]` | Ordered metadata authorities; list position is lookup priority. |
| `artifacts` | `ArtifactSourceList` | Ordered byte and checksum authorities; list position is lookup priority. |

<!-- readme-example id="api-sig-filesource" mode="signature" -->
```ts
type FileSource =
  | readonly string[]                                  // paths or globs, resolved from cwd
  | Readonly<Record<string, string | Uint8Array>>      // virtual files; no filesystem access
```

### sources.artifacts

<!-- readme-example id="api-sig-artifactsource" mode="signature" -->
```ts
type ArtifactSource = string | RemoteArtifactRegistry
type ArtifactSourceList = readonly ArtifactSource[]
```

| Value | Meaning |
|---|---|
| `'npm'`, `'yarn-berry'` | That manager's default cache. |
| `'npm:<path>'`, `'yarn-berry:<path>'` | An explicit cache location. |
| `RemoteArtifactRegistry` | Explicit remote-byte authorization. |
| `'pnpm'`, `'pnpm:<path>'` | Rejected — `INVALID_INPUT`. The decomposed pnpm store retains neither a registry tarball nor a lock-carried archive checksum. |
| unknown family, empty path | Rejected — `INVALID_INPUT`, before any filesystem or network access. |

Byte kinds are never relabelled: npm supplies the original registry tgz, Yarn
supplies its own repacked-zip checksum.

The element type is `string` so an inferred `string[]` is accepted.
`ArtifactCacheSpecifier` is exported as the precise opt-in grammar; normalization is
the runtime authority.

## guards

<!-- readme-example id="api-sig-guardprofile" mode="signature" -->
```ts
interface GuardProfile {
  patterns?: readonly TarballKey[]
  artifactCompressed?: ByteSize
  artifactInflated?: ByteSize
  artifactTarContent?: ByteSize
  artifactRepacked?: ByteSize
  artifactLive?: ByteSize
  networkTraffic?: ByteSize
}
```

Ordered, first match wins. An unpatterned fallback must be last; a patterned profile
after it fails eagerly, before any source is accessed.

| Field | Default | Scope |
|---|---|---|
| `artifactCompressed` | `'384 MiB'` | per artifact |
| `artifactInflated` | `'3 GiB'` | per artifact |
| `artifactTarContent` | `'3 GiB'` | per artifact |
| `artifactRepacked` | `'3 GiB'` | per artifact |
| `artifactLive` | `'7 GiB'` | operation-wide |
| `networkTraffic` | `'5 GiB'` | operation-wide, cumulative response bodies |

`ByteSize` is `` `${number} ${'B'|'kB'|'MB'|'GB'|'KiB'|'MiB'|'GiB'}` `` and must
resolve to a positive safe integer.

A ceiling aborts an operation; it never weakens verification. `Content-Length` is
checked against the compressed ceiling and the remaining traffic budget before the
body is read; each chunk debits the meter before it is retained. No ceiling failure
returns shortened bytes, and nothing partial is written to the store. Local hits
debit no network traffic.

Integrity verification against lock-carried digests is not overridable by any guard
setting.

## store

<!-- readme-example id="api-sig-block24" mode="signature" -->
```ts
store?: Store | false
```

| Value | Effect |
|---|---|
| omitted | The global store is read first and written back to. |
| `false` | No store read, no write, no path diagnostic. |
| `Store` | Replaces the global store for that operation. |

| Property | Value |
|---|---|
| default location | `$XDG_CACHE_HOME/lockgraph` when absolute, else `~/.cache/lockgraph` |
| default capacity | 5 GiB |
| eviction | deterministic least-recently-used; never removes an in-flight object |
| permissions | `0700` directories, `0600` files |
| commit | same-filesystem temp-and-rename, cross-process pins, dead-owner recovery |
| path diagnostic | `STORE_PATH_RESOLVED`, once, before the first store filesystem mutation |
| corruption | `ENRICH_ARTIFACT_STORE_CORRUPT`; the object is removed and traversal continues |

A hit is re-verified: its canonical SHA-512 object is checked, then it traverses the
same envelope and current-lock integrity checks an external byte would face. Digest
aliases are lookup indexes, not retained proof. Deleting the store and re-acquiring
from unchanged sources reproduces identical bytes and diagnostics.

Stable paths and metadata contain no package name, URL, header, token or raw
diagnostic.

## contracts

<!-- readme-example id="api-sig-conversioncontract" mode="signature" -->
```ts
type ConversionContract = 'snapshot' | 'policy' | 'install'
```

| Value | Requirement |
|---|---|
| `snapshot` | Project the bytes as they are. |
| `policy` | Additionally satisfy declared policy. |
| `install` | Additionally materialise what the target manager needs to install. |

Each rung includes the previous one. **`install` is not a claim that the manager will
accept the lock unchanged** — it says the lock carries the project topology, edge kinds
and package metadata an install needs. Whether the manager rewrites it is settled by
running it. There is no `frozen` value: see
[`prepareFrozen`](#preparefrozen) and
[CONVERT.md](./CONVERT.md#frozen-candidate-and-certification-lifecycle).

## Berry cache keys

Moving between Berry cache keys treats the existing checksum as source-domain
verification evidence: the tgz must reproduce it before the single Yarn-emittable
checksum is superseded with the target-domain digest.

| Cache key | Requirement |
|---|---|
| STORE, 7, 8, 9 | pure-JS pako path, always available |
| 10 | optional `@yarnpkg/libzip`; when absent and required, `ENRICH_ARTIFACT_INTEGRITY_UNSUPPORTED` names the remedy |
