# Converting between lockfiles

Three questions, in this order: **can it be done**, **what do I have to supply**,
**what do I lose**. This file answers them. For the call signatures see
[API.md](./API.md); for the format internals see [the format specs](../spec/pm/).

## Can it be done?

Every ordered pair is defined. Find your row (source) and column (target).

| From ↓ To → | npm | yarn-classic | yarn-berry | pnpm | bun | deno |
| --- | --- | --- | --- | --- | --- | --- |
| **npm** | **by version** | needs manifests | needs artifacts | just works | just works | not supported |
| **yarn-classic** | needs manifests | — | needs manifests | needs manifests | needs manifests | not supported |
| **yarn-berry** | just works | needs manifests | **by version** | just works | just works | not supported |
| **pnpm** | just works | needs manifests | just works | **by version** | just works | not supported |
| **bun** | just works | needs manifests | just works | just works | **by generation** | not supported |
| **deno** | npm subgraph only | npm subgraph only | npm subgraph only | npm subgraph only | npm subgraph only | **by version** |

- **just works** — the lock alone is enough. You may still lose a feature the target
  cannot express; see [what you lose](#what-you-lose).
- **needs manifests** — supply `sources.manifests`, or `dev`/`peer` and workspace
  members are wrong or missing.
- **needs artifacts** — supply `sources.artifacts`, or the Berry checksum cannot be
  computed. Berry uses a hash of its own repacked zip; no other format carries it.
- **npm subgraph only** — the npm packages convert; Deno's JSR and remote-URL modules
  have no carrier in a Node lockfile and are dropped with a diagnostic.
- **not supported** — fails closed with `CAPABILITY_LACK`. Synthesizing native Deno
  identities has never been validated against a real Deno release, so it is refused
  rather than guessed.
- **by version** — the family cell is not one answer. A lockfile generation is a
  format in its own right, and moving between two of them loses whatever the older
  one cannot express. See [within one family](#within-one-family).

`lockgraph` is the lossless waypoint: any format → `lockgraph` → the same format
round-trips graph-identical. It is the model serialized, not a package-manager lock.

**Looking for your exact pair?** All 380 of them have a row each in
[PAIRS.md](./PAIRS.md) — ✅ / ⚠️ / ❌ at a glance, plus the expected diagnostic, what
to add to the call, and what stays lost whatever you supply. Search it for your
source format.

## Within one family

Staying inside a family is not staying inside a format: each generation is its own
wire format. [PAIRS.md](./PAIRS.md) carries the recipe for every one of those pairs —
what follows is only what a pair row cannot express.

**npm** — the only lossy direction is *into* `npm-1`, which predates workspaces and
the packages block. Every other npm pair is clean both ways. Separately, the npm-4
patch carrier and its manifest-extension provenance are npm-4-native: a lock using
them loses them at **every** other target, `npm-2` and `npm-3` included.

**pnpm** — `v6 ↔ v9` is the only pair clean in both directions. Anything touching v5
drops tarball payload metadata, and descending to it also drops patches. The catalog
protocol is v9-only (pnpm 9.5+).

**yarn-berry** — two version boundaries, neither of them visible in a pair row:

| Axis | v4 | v5 | v6 | v7 | v8 | v9 | v10 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| os/cpu/libc conditions | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| checksum form | raw hex | raw hex | raw hex | raw hex | `<cacheKey>/<hex>` | same | same |

Descending to v4 drops the conditions block. Crossing v7 → v8 changes the checksum's
*shape*: v4–v7 emit a raw sha512 hex, v8 and later prefix it with the cache key. That
key is captured from the source lock verbatim rather than derived from the
generation, so producing a checksum for a key the source does not carry needs
artifact bytes — see [Berry cache keys](./API.md#berry-cache-keys).

Every berry → berry pair also drops an unknown `compressionLevel` metadata subkey.
That is producer-faithful, not a defect: every pinned Berry release strips it during
a mutable install.

**deno** — nothing converts *into* `deno-v5`. Descending from v5 names the exact
per-entry fields that have no target representation; targeting v2 or v3 additionally
drops any non-empty JSR, workspace or redirect carrier.

**bun** — two generations, two format ids: `bun-text` is `lockfileVersion: 1` and
`bun-text-v2` is `2` (bun 1.4+). The schema is the same — a feature-rich project emits
byte-identical locks under 1.3.14 and 1.4.0 apart from that integer, and all seven
scenario fixtures reproduce that exactly — so bun → bun is lossless in both directions.
They are separate ids because the generation has to be REQUESTABLE: converting into bun
from another family has no bun source to inherit one from, and with a single id every
cross-family conversion would yield a `1` forever, leaving a bun-1.4 user unable to ask
for the lock their own bun writes.

Yarn Classic has one generation, so it has no intra-family axis.

## Show me

### The lock is enough

<!-- readme-example id="cv-basic" mode="typecheck" -->
```ts
import { readFile, writeFile } from 'node:fs/promises'
import { convert } from 'lockgraph'

const lock = await convert(await readFile('pnpm-lock.yaml', 'utf8'), { target: 'npm-3' })
await writeFile('package-lock.json', lock)
```

### The target needs your `package.json`

A `yarn.lock` records neither the project root nor which dependencies are `dev`.
Both live in manifests, so hand them over. `sources.manifests` takes paths or globs.

<!-- readme-example id="cv-manifests" mode="typecheck" -->
```ts
import { readFile, writeFile } from 'node:fs/promises'
import { convert } from 'lockgraph'

const lock = await convert(await readFile('yarn.lock', 'utf8'), {
  target: 'npm-3',
  sources: { manifests: ['package.json', 'packages/*/package.json'] },
})
await writeFile('package-lock.json', lock)
```

Miss a workspace member and it vanishes from the output — see
[the sharp edges](#the-two-sharp-edges).

### The target needs archive bytes

Only Yarn Berry needs this: its checksum covers a zip only Yarn produces, so it is
recomputed from real bytes. Sources are tried in order, first hit wins.

<!-- readme-example id="cv-artifacts" mode="typecheck" -->
```ts
import { readFile, writeFile } from 'node:fs/promises'
import { convert } from 'lockgraph'

const lock = await convert(await readFile('package-lock.json', 'utf8'), {
  target: 'yarn-berry-v10',
  sources: { artifacts: ['yarn-berry:.yarn/cache', 'npm'] },
})
await writeFile('yarn.lock', lock)
```

Bytes are verified against the lock's own integrity before anything is recomputed.
A checksum is never fabricated: if it cannot be proven, the conversion refuses.

### Don't throw, just tell me

By default an unmet requirement throws `LockfileError`. `strict: false` emits the
best-effort result and reports each loss instead.

<!-- readme-example id="cv-diagnostics" mode="typecheck" -->
```ts
import { readFile } from 'node:fs/promises'
import { convert } from 'lockgraph'

await convert(await readFile('yarn.lock', 'utf8'), {
  target: 'npm-3',
  strict: false,
  onDiagnostic: (d) => console.warn(d.code, d.subject),
})
```

### Convert the project, not just the lock

Some policy is not in the lock at all. npm and Yarn read overrides from
`package.json`, never from the lockfile — so converting pnpm → npm has to change two
files or the result installs the wrong versions. Pass the project and get both back.

<!-- readme-example id="cv-project" mode="typecheck" -->
```ts
import { convert } from 'lockgraph'

const { lockfile, companions } = await convert(
  ['package.json', 'pnpm-lock.yaml', 'packages/*/package.json'],
  { target: 'npm-3', contract: 'install' },
)
```

`companions` are the other files the target manager needs changed, as immutable
`set` operations. Nothing is written — applying them is your step, so a partial
result cannot be applied by accident.

## It refused. What do I feed it?

| Diagnostic | What it means | What fixes it |
| --- | --- | --- |
| `ENRICH_REQUIRED` | The target needs a value the source lock never carried. | Evidence — usually `sources.artifacts` for checksums, `sources.packuments` for metadata. The message names the entry and the missing field. |
| `RECIPE_INTEGRITY_INCOMPLETE` | The target's hash form is not derivable from the graph. | Artifact bytes to recompute from, or an authoritative target checksum. Never fabricated. |
| `ENRICH_ARTIFACT_INTEGRITY_MISSING` | Bytes were offered for an entry with no verifiable digest. | Nothing to supply — the lock cannot prove those bytes. Fix the source lock. |
| `YARN_CLASSIC_NO_MANIFESTS` | `dev` / `peer` classification is unprovable from a `yarn.lock`. | `sources.manifests`. `dev` becomes recoverable; **`peer` does not**. |
| `RECIPE_WORKSPACE_COLLAPSED` | `workspace:` has no target protocol. | Nothing for npm; the members survive as paths. For yarn-classic, manifests. |
| `INTEROP_OVERRIDE_NOT_PROJECTED` | The pin survives in the graph; the re-emittable overrides block does not. | The project form of `convert`, which returns the companion manifest patch. |
| `PROJECTION_LOSS` | The target cannot represent the feature at all. | Nothing. Accept it with `strict: false`, or pick another target. |
| `CAPABILITY_LACK` | The pair itself is unsupported. | Nothing. The message names what no pinned producer has validated. |
| `INVALID_INPUT` | A source specifier is malformed or names something inert. | Fix the call — e.g. `pnpm` in `sources.artifacts`, which retains no archive. |
| `DENO_MANIFEST_REQUIRED` | Deno's dev/prod scope is not in `deno.lock`. | The sibling `deno.json` or `package.json`. |

Full code list: [ERRORS.md](./ERRORS.md).

## What you lose

Conversion targets *semantic equivalence*, not byte-preservation. A feature is lost
when the target format has nowhere to put it — and "dropped" is not the same as
"unrecoverable": where the target has a carrier, enrichment refills it.

Which features go for **your** pair, the diagnostic to expect, and what to add to the
call are one row each in [PAIRS.md](./PAIRS.md), generated from the interop contracts.
That table is not reproduced here: a hand-kept second copy of 380 rows would drift
from the first one it disagreed with.

## The two sharp edges

Both produce a lockfile that installs *wrong* rather than one that fails loudly, so
they are worth knowing by name.

1. **A `yarn.lock` cannot describe a monorepo on its own.** yarn 1 records a
   workspace member only when something depends on it. An independent member has no
   entry at all. Convert without every member `package.json` and those members
   silently vanish, while unhoistable transitive versions leak into an internal
   store key npm cannot install.
2. **`dev` / `peer` are not in a `yarn.lock`.** They live only in `package.json`.
   Without manifests `dev` collapses to a plain dependency — and `peer` is not
   recoverable even with them, because yarn-classic manifest synthesis reads only
   `dependencies`.

## Contracts: how much proof you are asking for

`contract` says how thoroughly the result must be provable. Higher rungs demand more
evidence and refuse more often.

| Contract | Question it answers | Needs |
| --- | --- | --- |
| `'snapshot'` (default) | Does the target describe the same resolved graph? | The lock; manifests when the source is manifest-blind. |
| `'policy'` | …and does it carry the same override policy? | Plus the authored overrides — from the root manifest, or PM config where that manager keeps them outside `package.json`. |
| `'install'` | …and would the target manager install it unchanged? | Plus the full manifest set and authoritative metadata for every non-workspace package. |

Frozen is not a fourth rung. It cannot be requested, because it is a claim about a
package manager that has actually run. See below.

## Frozen candidate and certification lifecycle

Freeze-mode acceptance — `npm ci`, `yarn install --immutable`, `pnpm install
--frozen-lockfile` — is the real gate, and only the genuine manager can open it.
Lockgraph never executes a package manager, so it splits the job in two:

1. **`prepareFrozen(input, options)`** does the whole pipeline once against an exact
   `managerVersion` and returns an opaque `FrozenCandidate` — a challenge, not a
   certification. Its status stays `unassessed`.
2. **Your runner** materializes the candidate in a fresh project, runs the native
   frozen command with scripts disabled, and compares the input tree byte-for-byte.
   Exit 0 plus an unchanged tree earns a `FrozenVerificationReceipt`.
3. **`certifyFrozen(candidate, receipt)`** accepts only that candidate with a receipt
   echoing its exact target and `projectionDigest`, and returns the same output with
   a satisfied assessment.

A receipt proves **integrity, not authenticity**: it binds the attestation to this
exact candidate and rejects stale or cross-project reuse, but it cannot prove an
untrusted producer really ran the manager. Lockgraph's own CI claims are earned by
executing the pinned binaries.

The calibrated CI matrix covers npm 6–12, Yarn Classic 1.22.22, Yarn Berry 2.4.3
through 4.17.1 (seven pinned generations), pnpm 6–10 plus 12, and bun 1.3.14 + 1.4.0 — each
within its Node runtime range where one applies. The two bun pins are deliberate: one
writes `lockfileVersion: 1` and the other `2`, and only 1.3.14 exercises the refusal of
a `2`.

Some output is byte-identical to the manager's own, not merely acceptable to it: npm
locks survive even a mutable `npm install`, and Berry locks re-emit the canonical
preamble, quoting and checksums byte-for-byte. Cross-family output is usually
semantically equivalent without being byte-identical, since layout and hoisting are
re-synthesized.

## Deeper

Everything above is the user-facing contract. The mechanics live elsewhere:

- [PAIRS.md](./PAIRS.md) — one recipe row per ordered format pair, all 380.
- [API.md](./API.md) — signatures, `sources`, `guards` byte ceilings, `store`.
- [ERRORS.md](./ERRORS.md) — every diagnostic code.
- [spec/10-sources.md](../spec/10-sources.md) — the evidence ladder, registry
  routing, and the artifact byte path.
- [spec/pm/](../spec/pm/) — per-manager format specs and fidelity notes.
