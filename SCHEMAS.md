# Lockfile schemas

Public reference for every lockfile schema this project recognises:
how to identify each, which package-manager versions emit it by
default, and which can install from it. Adapter ids match the
`FormatId` literal accepted by `parse({ format })` and required by
`stringify({ format })`.

> Source of truth lives in the project spec, not here.
> `spec → implementation → SCHEMAS.md` — never the reverse.
> See [Update flow](#update-flow) at the bottom.

## npm

| Adapter id | Marker | Default writer | Reader |
|------------|--------|----------------|--------|
| `npm-1`    | `lockfileVersion: 1` | npm `>=5 <7` | npm `>=5` |
| `npm-2`    | `lockfileVersion: 2` | npm `>=7 <9` | npm `>=7` |
| `npm-3`    | `lockfileVersion: 3` | npm `>=9`    | npm `>=7` |

`npm install --lockfile-version=N` overrides the writer choice within
the supported range.

## yarn

`yarn-classic` and `yarn-berry-*` use different lockfile schemas. The
"v" suffix on berry adapters is `__metadata.version`. Yarn classic
uses a `# yarn lockfile v1` *comment header* instead — unrelated to
berry's `__metadata`.

| Adapter id        | Marker                       | Default writer       | Reader  |
|-------------------|------------------------------|----------------------|---------|
| `yarn-classic`    | `# yarn lockfile v1` header  | yarn `>=1 <2`        | yarn `>=1 <2` (native); yarn `>=2` via `yarn import` |
| `yarn-berry-v3`   | `__metadata.version: 3`      | yarn `>=2.0.0-rc.4 <2.0.0-rc.20` (pre-release only) | yarn `>=2` |
| `yarn-berry-v4`   | `__metadata.version: 4`      | yarn `>=2.0.0-rc.20 <3.1` | yarn `>=2` |
| `yarn-berry-v5`   | `__metadata.version: 5`      | yarn `=3.1.0` (one minor) | yarn `>=3.1` |
| `yarn-berry-v6`   | `__metadata.version: 6`      | yarn `>=3.2 <4`      | yarn `>=3.2` |
| `yarn-berry-v8`   | `__metadata.version: 8`      | yarn `>=4.0 <4.14`   | yarn `>=4` |
| `yarn-berry-v9`   | `__metadata.version: 9`      | yarn `>=4.14`        | yarn `>=4.14` |

**Schema numbers that don't exist:**
- `__metadata.version: 1` and `2` were never used by berry.
- `__metadata.version: 7` was skipped — yarn went `6 → 8` in 4.0.0.

`YARN_LOCKFILE_VERSION_OVERRIDE` (yarn 4+) lets one binary write any
schema version it can read; structural fidelity to the canonical
writer is not guaranteed.

## pnpm

| Adapter id | Marker                   | Default writer       |
|------------|--------------------------|----------------------|
| `pnpm-v5`  | `lockfileVersion: 5.x`   | pnpm `>=3 <8`  (pnpm 7 stayed on `5.4` by default) |
| `pnpm-v6`  | `lockfileVersion: '6.0'`/`'6.1'` | pnpm `>=8 <9` |
| `pnpm-v9`  | `lockfileVersion: '9.0'` | pnpm `>=9`           |

**Schema numbers that don't exist:** `7` and `8`. pnpm 9 jumped
straight from `6.x` to `9.0`.

## bun

| Adapter id    | Marker                          | Default writer | Status |
|---------------|---------------------------------|----------------|--------|
| `bun-text`    | `bun.lock` filename + JSONC     | bun `>=1.2`    | primary bun target |
| `bun-binary`  | `bun.lockb` filename + magic    | bun `<1.2`     | deferred for v1 |

bun `>=1.2` keeps a binary reader for back-compat. Older bun versions
also recognise the binary by default; the text format (`bun.lock`) is
opt-in below 1.2 via `--save-text-lockfile` and default from 1.2 on.

## Update flow

`SCHEMAS.md` is **derived**. It cannot be edited directly to introduce
a new fact about a schema. The canonical flow:

1. Update the spec section that names the fact
   (e.g. `spec/formats/<adapter>.md`'s Compatibility table).
2. Apply the change in implementation (`src/test/resources/fixtures/_gen.mjs`,
   parser/formatter when those land).
3. Reflect the change in this table.

Reverse-direction edits (changing this table without touching the
spec) drift the public projection from the contract.

> The spec under `spec/` is currently kept private during early
> iteration (see `.gitignore`). Once it stabilises, this preamble
> will link directly to its sections.
