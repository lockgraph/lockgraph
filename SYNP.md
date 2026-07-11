# synp and lockgraph

## Concept and credit

[`synp`](https://github.com/imsnif/synp) is the original lockfile converter: it
translates a `yarn.lock` into a `package-lock.json` and back. It established that
the two formats are convertible at all, mapped the field correspondence between
them, and handled scopes, integrity hashes and git sources. It has served the npm
and yarn communities for years and is the reference point every later converter,
including this one, is measured against. lockgraph builds on that groundwork.

lockgraph (`lockgraph`) is a universal lockfile **model** and
converter. It spans npm (`package-lock.json` v1/v2/v3), yarn classic, yarn berry
(v4–v10), pnpm (v5/v6/v9) and bun (`bun.lock`), and converts any of them to any
other through a single canonical graph. It runs as a pure library: no package
manager is required, no `node_modules` is read, no install is performed.

## Why the approach changed

synp reconstructs what a lockfile omits — dependency-type classification, the
`requires` map — by shelling out to npm and yarn and walking an installed
`node_modules` tree on disk. That model is sound when a project installs cleanly
on the same machine that runs the conversion. Four requirements pulled lockgraph
to a different model:

- **No install, no `node_modules`.** Convert in CI, in the browser, or on a
  legacy project that no longer installs — with no package manager present.
  lockgraph derives the entire graph from the lockfile bytes (plus `package.json`
  bytes when supplied, plus the registry when opted in). It never reads
  `node_modules`, so a stale, absent or inconsistent install cannot affect it.
- **Frozen-clean output.** The generated lock must pass the package manager's
  freeze mode — `npm ci`, `yarn install --immutable`, `pnpm install
  --frozen-lockfile` — with no rewrite. That demands byte-level fidelity of the
  irreducible facts (integrity, resolution URLs), which a field-by-field map does
  not guarantee. This is verified against the package managers themselves: both
  `npm ci` and `yarn --immutable` accept a lockgraph-generated lock byte-identical.
- **Breadth.** Not just yarn ↔ npm, but berry, pnpm, bun and every npm lockfile
  version, any direction. A pairwise converter does not scale to that matrix; a
  canonical graph does — each format needs only a parser and a stringifier.
- **Robustness.** synp's characteristic failure is an undefined dereference when
  the disk and the lock disagree. lockgraph replaces ad-hoc failure with a typed
  `LockfileError` and structured `Diagnostic` values, so a malformed or unusual
  input is reported, not crashed on.

The result is a three-layer model — **Manifest** (declared constraints) →
**Graph** (resolved, peer-aware instances and their edges) → **Layout** (physical
projection) — that is never collapsed. Conversion is the simple case of parsing
one layer and stringifying another; the general case assembles the target from
whichever source can supply each fact.

| Dimension        | synp                                   | lockgraph                                                        |
| ---------------- | -------------------------------------- | --------------------------------------------------------------- |
| Source of truth  | installed `node_modules` + lockfile    | lockfile bytes (+ `package.json`, + opt-in registry)            |
| Package managers | npm and yarn installed                 | none                                                            |
| Formats          | yarn classic ↔ npm                     | npm v1/v2/v3, yarn classic, berry v4–v10, pnpm v5/v6/v9, bun    |
| Model            | pairwise field map                     | canonical graph (any → any)                                     |
| Failure mode     | undefined dereference                  | typed `LockfileError` + `Diagnostic`                            |
| Target           | semantic conversion                    | semantic conversion **and** frozen-clean install               |

## Issue coverage

Every issue on the synp tracker as of this writing, **newest first** — so the most
recent reports, which are also the ones most often still open on synp, sit at the
top. **synp** is the issue's state on that tracker (`open` marks a problem still
unsolved there); **lockgraph** is whether the underlying need, bug or request is
addressed here. `Closed` — addressed; `Partial` — addressed under a stated
condition; `Out of scope` — a synp CLI, release or dependency matter with nothing
to convert.

Issues marked **T** have an executable regression test in
[`src/test/interop/synp-issues/synp-issues.test.ts`](src/test/interop/synp-issues/synp-issues.test.ts).
Issues marked **R** are covered by the real-world sweep in
[`src/test/interop/real-world/yarn-classic-robustness.test.ts`](src/test/interop/real-world/yarn-classic-robustness.test.ts).

| #                                                     | Title (abridged)                              | synp   | lockgraph        | How |
| ----------------------------------------------------- | --------------------------------------------- | ------ | ---------------- | --- |
| [110](https://github.com/imsnif/synp/issues/110)      | Support for `bun.lock`                         | open   | Closed **T**     | lockgraph ships a `bun-text` adapter that detects and converts the textual `bun.lock`; the binary `bun.lockb` is an intentional non-goal. |
| [106](https://github.com/imsnif/synp/issues/106)      | Workspace dependencies lost, lock invalid     | open   | Partial          | Members are reconstructed from caller-supplied workspace manifests (member synthesis and edge classification are proven by test); the capability is conditional on passing every workspace `package.json`. |
| [103](https://github.com/imsnif/synp/issues/103)      | `optionalDependencies` dropped yarn→npm        | open   | Closed **T**     | Optional dependencies are modeled as first-class `optional` edges; the platform package is carried into the npm target with its `resolved` URL and integrity intact, so npm installs it from the lock instead of dropping it as synp did. |
| [102](https://github.com/imsnif/synp/issues/102)      | Not working with Yarn 3.x                      | open   | Closed           | Berry locks parse from bytes with no `node_modules`, so a PnP project (which has none) converts. |
| [101](https://github.com/imsnif/synp/issues/101)      | Workspace conversion fails on invalid manifests | open | Closed           | The failure was `nmtree` reading a malformed `node_modules/**/package.json`; lockgraph never walks `node_modules`, working from bytes plus supplied manifests. |
| [100](https://github.com/imsnif/synp/issues/100)      | Every module has empty `requires`             | open   | Closed **T**     | Each node's dependency edges are reconstructed from the graph, so `requires` is populated at every level rather than left empty. |
| [99](https://github.com/imsnif/synp/issues/99)        | package-lock v3 not working with npmToYarn    | open   | Closed **T**     | The npm v3 adapter reads the `packages` map directly and does not depend on the legacy `dependencies` mirror that npm v9 omits. |
| [97](https://github.com/imsnif/synp/issues/97)        | `sourceFile.split is not a function`           | closed | Out of scope     | A CLI argument-order mistake; lockgraph takes input as a typed string argument. |
| [96](https://github.com/imsnif/synp/issues/96)        | `package-lock` overwritten after `npm install` | closed | Closed **T**     | The complaint is that npm had to rewrite the generated lock; making a lock npm does not rewrite is the core goal here. Verified against npm 11: `npm ci` (the freeze gate) accepts a lockgraph-generated lock byte-identical, no rewrite, on a real tree with optional platform packages. Mutable `npm install` re-canonicalizes intra-entry field order (npm's own serializer) without changing the resolved tree. |
| [95](https://github.com/imsnif/synp/issues/95)        | Unknown token (Yarn 3.x/4.x)                   | open   | Closed **T**     | `__metadata.version` 6 and 4 detect as `yarn-berry-v6`/`yarn-berry-v4` and parse from bytes; no `node_modules` is required. |
| [93](https://github.com/imsnif/synp/issues/93)        | Why do I need a `node_modules` folder?         | open   | Closed           | lockgraph runs offline against the lockfile bytes alone, so a project that cannot install still converts. |
| [91](https://github.com/imsnif/synp/issues/91)        | Add `resolutions` support                      | open   | Closed           | yarn `resolutions` are captured from the manifests into a canonical override model and emitted as npm nested `overrides`; `overridesOf` reads them back. |
| [90](https://github.com/imsnif/synp/issues/90)        | Terminal broken after conversion              | closed | Out of scope     | Fallout of the compromised colors.js dependency; lockgraph has no such dependency and prints no decorative output. |
| [89](https://github.com/imsnif/synp/issues/89)        | Release has no matching tag                    | open   | Out of scope     | A synp release-provenance alert. |
| [88](https://github.com/imsnif/synp/issues/88)        | Automated release is failing                  | closed | Out of scope     | synp's own release-pipeline maintenance. |
| [86](https://github.com/imsnif/synp/issues/86)        | Pin `colors.js` to 1.4.0                       | closed | Out of scope     | A supply-chain pin against synp's own dependency tree; lockgraph does not depend on colors.js. |
| [74](https://github.com/imsnif/synp/issues/74)        | Fix npm v7 / package-lock v2 converter        | open   | Closed           | npm v2 is a first-class format: it re-emits both the path-keyed `packages` block and a consistent legacy `dependencies` mirror. |
| [72](https://github.com/imsnif/synp/issues/72)        | `checkWorkspace` flag typo                     | closed | Out of scope     | A synp CLI flag/warning-text defect; lockgraph ships no CLI. |
| [62](https://github.com/imsnif/synp/issues/62)        | `package-lock` missing some deps vs npm       | open   | Partial          | Full dep/dev/optional/peer classification is recovered when the caller passes the manifests; without them, `dev`/`peer` collapse to `dep` (no `node_modules` heuristic re-derives them). |
| [61](https://github.com/imsnif/synp/issues/61)        | Do not require bash for monorepos             | open   | Closed           | lockgraph is a pure library that reconstructs workspace members from bytes plus supplied manifests, with no shell or glob dependency. |
| [59](https://github.com/imsnif/synp/issues/59)        | dev dependencies losing the `dev` flag        | closed | Closed           | `dev` is recovered as a typed edge from the workspace manifest and emitted deterministically when manifests are supplied. |
| [55](https://github.com/imsnif/synp/issues/55)        | `package-lock` lacks deps meta of entries     | closed | Closed **T**     | `requires` is emitted from the declared edge range (the caret survives, not the resolved pin) and nested `dependencies` conflict blocks are emitted from the resolved tree. |
| [53](https://github.com/imsnif/synp/issues/53)        | Composite version syntax in `package.json`    | closed | Closed **T**     | The lockfile's own version string is carried verbatim (build metadata included); lockgraph never reads an installed manifest, so a published-vs-declared mismatch cannot arise. |
| [51](https://github.com/imsnif/synp/issues/51)        | `dev` marker wrong for scoped packages        | closed | Closed           | `dev` is a typed edge classified from the manifest, not inferred from `node_modules` path-segment counts, so scoped-package nesting cannot corrupt it. |
| [46](https://github.com/imsnif/synp/issues/46)        | Could not find parent dir!                    | closed | Closed **R**     | The error came from synp's install-path walker; lockgraph builds layout from an explicit tree, and `git+ssh://` / scp-form git refs are parsed as git resolutions. |
| [44](https://github.com/imsnif/synp/issues/44)        | yarn→npm conversion ignores workspaces        | closed | Partial **T**    | Every same-name version is kept as a distinct node (no last-write-wins collapse); full workspace-member and dev classification additionally requires the `package.json` manifests, which yarn.lock alone does not encode. |
| [40](https://github.com/imsnif/synp/issues/40)        | Use without multiple package managers         | closed | Closed           | Converting with zero package managers and no `node_modules` is lockgraph's design premise — the direct inverse of synp's requirement. |
| [30](https://github.com/imsnif/synp/issues/30)        | Trouble converting with `file://` urls        | closed | Closed **R**     | Relative `file:`/`link:`/`portal:` values are modeled as directory resolutions, not parsed as URLs, so a local path never reaches the URL parser that synp crashed in. |
| [29](https://github.com/imsnif/synp/issues/29)        | No matching version for `dependencies@undefined` | open | Closed         | The stray `dependencies` block was a `node_modules`-traversal artefact; lockgraph emits the npm layout from an explicit tree, never from a scanned directory. |
| [27](https://github.com/imsnif/synp/issues/27)        | Git dependencies seem broken                  | closed | Closed **R**     | Git dependencies are modeled with a `#<sha>` commit resolution and the yarn adapter re-emits the resolved git URL verbatim, so the pinned ref survives conversion. |
| [26](https://github.com/imsnif/synp/issues/26)        | Add `--force` to delete an existing lockfile  | closed | Out of scope     | A CLI file-overwrite flag; lockgraph is a library that returns the target lock as a string and never writes the filesystem. |
| [25](https://github.com/imsnif/synp/issues/25)        | Cannot convert undefined or null to object    | closed | Closed           | The error was synp requiring a prior `npm install`; lockgraph converts offline from the `package-lock` bytes alone. |
| [24](https://github.com/imsnif/synp/issues/24)        | Tarball support missing                       | closed | Partial          | Non-registry tarball sources are modeled as first-class via the resolution recipe and `TarballPayload`; byte-identical tarball-as-`version` round-tripping is represented but not separately asserted. |
| [23](https://github.com/imsnif/synp/issues/23)        | Finding issues (explain missing versions)     | closed | Partial          | Opaque throws are replaced by typed errors and diagnostics that name the failing entry; a truly required missing version still hard-fails rather than being repaired. |
| [21](https://github.com/imsnif/synp/issues/21)        | Update README with `yarn import`              | closed | Out of scope     | A documentation request about synp's own README. |
| [19](https://github.com/imsnif/synp/issues/19)        | Cannot read property 'forEach' of undefined   | closed | Closed           | The crash came from an installed tree inconsistent with the lock; lockgraph tolerates degraded/optional entries on parse with a benign diagnostic rather than a traversal crash. |
| [18](https://github.com/imsnif/synp/issues/18)        | Add support for pnpm                          | closed | Closed           | pnpm v5/v6/v9 are first-class parse/stringify/detect formats and participate as any → any conversion targets. |
| [17](https://github.com/imsnif/synp/issues/17)        | `dependencies@undefined` yarn→npm             | closed | Closed           | The stray `dependencies@undefined` came from reconciling against an installed `node_modules`; lockgraph reads only the lockfile bytes, so there is no install to diverge from. |
| [14](https://github.com/imsnif/synp/issues/14)        | Cannot convert undefined or null to object    | closed | Closed           | Conversion runs from bytes with no `node_modules` reconciliation; genuinely malformed input fails with a typed `LockfileError`, not a raw type error. |
| [13](https://github.com/imsnif/synp/issues/13)        | Cannot read property 'replace' of undefined   | closed | Closed **T**     | A `github:` source inside a parent's `requires` parses to a bare node without an integrity dereference (the value synp crashed on). |
| [12](https://github.com/imsnif/synp/issues/12)        | github sources mis-converted npm→yarn         | closed | Closed **T**     | The same protocol path recognizes the `github:` version and re-emits the git ref in yarn's tarball form; no hand-stripping of github entries is needed. |
| [9](https://github.com/imsnif/synp/issues/9)          | Support `codeload.github.com` packages        | closed | Closed **T**     | The resolution recipe canonicalizes a `codeload.github.com/<o>/<r>/tar.gz/<sha>` tarball to a git identity; the reverse `github:` version is recognized on parse. |
| [8](https://github.com/imsnif/synp/issues/8)          | Unsuccessful conversion (CRLF, Unknown token) | closed | Closed **T**     | The yarn parser normalizes line endings and strips the BOM before tokenizing, so a CRLF lock parses identically to an LF one. |
| [7](https://github.com/imsnif/synp/issues/7)          | Support yarn integrity field                  | closed | Closed **R**     | yarn `integrity` is parsed into the multi-hash `Integrity` multiset (origin-tagged, order-preserving) and re-emitted verbatim; locks without the field are unaffected. |
| [6](https://github.com/imsnif/synp/issues/6)          | Conversion from `package-lock.json` fails      | closed | Closed **T**     | A `github:` version is recognized as a URL-like locator and integrity is gated so it is never fabricated or dereferenced for a git source; the crash cannot occur. |
| [5](https://github.com/imsnif/synp/issues/5)          | Traversable dependency graph                  | open   | Closed           | A traversable, package-manager-independent graph built purely from bytes with no `node_modules` is lockgraph's core model — exactly what the issue proposes. |
| [4](https://github.com/imsnif/synp/issues/4)          | Duplicate versions across dependencies        | closed | Closed **R**     | The npm adapter walks the `package-lock` tree with npm-v6 scope resolution and materializes each resolved instance as a distinct `NodeId`, so nested duplicates are represented, not flattened. |
| [3](https://github.com/imsnif/synp/issues/3)          | Handle scopes and complex version strings     | closed | Closed **R**     | A dedicated entry-key tokenizer parses `@scope/name@range` and comma-joined multi-descriptor keys; non-semver locators (git/file/link/npm-alias) are first-class range protocols. |
| [2](https://github.com/imsnif/synp/issues/2)          | Behaviour for duplicates across dep types     | closed | Closed           | The graph keys each instance by `NodeId` (name@version), so the same package at different versions across `dependencies` vs `devDependencies` is two explicit nodes. |
| [1](https://github.com/imsnif/synp/issues/1)          | Add error checking everywhere                 | closed | Closed           | Structured `LockfileError` codes plus typed `Diagnostic` values thread through every adapter, replacing ad-hoc undefined dereferences. |

