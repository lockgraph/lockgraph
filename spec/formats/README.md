# Format specifications

> Updated: 2026-06-16.

Per-adapter specs. Each document follows [`_template.md`](./_template.md) and
captures: compatibility, filename/encoding, sources, schema sketch, capability
matrix, quirks, degradation rules, fixtures and open questions.

> **⚠️ PM versions ≠ format versions.** A single package-manager major
> routinely writes several lockfile formats (defaults plus opt-in flags) and
> reads even more. A single format is written by a *range* of PM versions —
> default for some, fall-back for others. Adapters in this project are keyed
> on the **lockfile schema**, never on the PM major. Each per-format doc
> declares the exact semver windows for *writing* and *reading* separately.

## Provenance

Every spec declares its provenance to set expectations:

- **Official** — the format has a published, maintained schema spec.
- **Source-only** — no published spec; truth lives in the producer's source
  code (parser/serializer).
- **Reverse-engineered** — neither published spec nor readable source for the
  serializer; spec is built by inspecting outputs and probing edge cases.

## Index

| Id | Schema marker | Provenance | Doc |
|----|---------------|------------|-----|
| `npm-1`            | `lockfileVersion: 1`        | Official            | [npm-1.md](./npm-1.md) |
| `npm-2`            | `lockfileVersion: 2`        | Official            | [npm-2.md](./npm-2.md) |
| `npm-3`            | `lockfileVersion: 3`        | Official            | [npm-3.md](./npm-3.md) |
| `yarn-classic`     | header comment only         | Source-only         | [yarn-classic.md](./yarn-classic.md) |
| `yarn-berry-v3`    | `__metadata.version: 3` (RC-only) | Source-only   | [yarn-berry-v3.md](./yarn-berry-v3.md) |
| `yarn-berry-v4`    | `__metadata.version: 4`     | Source-only         | [yarn-berry-v4.md](./yarn-berry-v4.md) |
| `yarn-berry-v5`    | `__metadata.version: 5`     | Source-only         | [yarn-berry-v5.md](./yarn-berry-v5.md) |
| `yarn-berry-v6`    | `__metadata.version: 6`     | Source-only         | [yarn-berry-v6.md](./yarn-berry-v6.md) |
| `yarn-berry-v7`    | `__metadata.version: 7` (Yarn 4 RC) | Source-only | [yarn-berry-v7.md](./yarn-berry-v7.md) |
| `yarn-berry-v8`    | `__metadata.version: 8`     | Source-only         | [yarn-berry-v8.md](./yarn-berry-v8.md) |
| `yarn-berry-v9`    | `__metadata.version: 9`     | Source-only         | [yarn-berry-v9.md](./yarn-berry-v9.md) |
| `yarn-berry-v10`   | `__metadata.version: 10`    | Source-only         | [yarn-berry-v10.md](./yarn-berry-v10.md) |
| `pnpm-v5`          | `lockfileVersion: 5.x`      | Source-only         | [pnpm-v5.md](./pnpm-v5.md) |
| `pnpm-v6`          | `lockfileVersion: 6.x`      | Source-only         | [pnpm-v6.md](./pnpm-v6.md) |
| `pnpm-v9`          | `lockfileVersion: '9.0'`    | Source-only         | [pnpm-v9.md](./pnpm-v9.md) |
| `bun-text`         | `bun.lock` filename + JSONC | Official            | [bun-text.md](./bun-text.md) |
| `bun-binary`       | `bun.lockb` filename + magic | Reverse-engineered | [bun-binary.md](./bun-binary.md) |
| `lockgraph`        | `@lockgraph` magic (first token) | **Native**     | [lockgraph.md](./lockgraph.md) |

> **`lockgraph` is not a package-manager lockfile.** It is this project's own
> portable, versioned serialization of the L2 Graph — a sibling format on the
> same `parse` / `stringify` / `convert` plumbing, whose round-trip is
> graph-*identity* (`parse(serialize(g)) ≡ g`) rather than graph-equivalence
> up to a foreign PM schema. It has no PM writers/readers; the compatibility
> tables below do not apply to it. See [lockgraph.md](./lockgraph.md).

## PM × format compatibility

`RW` = read + write; `R` = read-only; `(default)` = the format this PM emits
without flags; `(opt-in)` = available behind a CLI flag or config switch;
`–` = no support. Every cell is "to be verified against actual installs" —
treat as design intent until validated by the [test bench](../08-test-bench.md).

### npm

| npm semver  | `npm-1` | `npm-2` | `npm-3` | Notes |
|-------------|---------|---------|---------|-------|
| `>=5 <7`    | RW (default) | – | – | introduced lockfileVersion |
| `>=7 <9`    | RW (opt-in)  | RW (default) | RW (opt-in) | added `--lockfile-version` |
| `>=9`       | R           | RW (opt-in) | RW (default) | dropped v1 *writer* |

### yarn

| yarn semver       | `yarn-classic` | `yarn-berry-v4` | `yarn-berry-v5` | `yarn-berry-v6` | `yarn-berry-v7` | `yarn-berry-v8` | `yarn-berry-v9` | Notes |
|-------------------|----------------|------------------|------------------|------------------|------------------|------------------|------------------|-------|
| `>=1 <2`          | RW (default)   | – | – | – | – | – | – | classic line ends here |
| `>=2 <3.1`        | R (`yarn import`) | RW (default) | – | – | – | – | – | empirically verified yarn 2.4.3 emits `__metadata.version: 4` |
| `=3.1`            | R (`yarn import`) | R | RW (default) | – | – | – | – | one-minor v5 window; yarn 3.1.0 only |
| `>=3.2 <4`        | R (`yarn import`) | R | R | RW (default) | – | – | – | jumps to v6 in 3.2.0 |
| Yarn 4 RC window  | R (`yarn import`) | R | R | R | RW (default)    | – | – | `4.0.0-rc.27..rc.X`: transitional default before stable cut to v8 |
| `>=4 <4.14`       | R (`yarn import`) | R | R | R | R                | RW (default) | – | stable Yarn 4 jumped to v8 at the 4.0 cut; reads v7 RC artefacts |
| `>=4.14`          | R (`yarn import`) | R | R | R | R                | R            | RW (default) | bumped to v9 in 4.14.0 (2026-04-16) |

### pnpm

| pnpm semver  | `pnpm-v5` | `pnpm-v6` | `pnpm-v9` | Notes |
|--------------|-----------|-----------|-----------|-------|
| `>=3 <8`     | RW (default) | – | – | pnpm 7 stayed on 5.4 by default for most of its life |
| `>=8 <9`     | R         | RW (default) | – | new package-id grammar; `packages`/`snapshots` split |
| `>=9`        | R         | R | RW (default) | pnpm 9 jumped lockfileVersion from 6.x straight to 9.0; no v7 / v8 schemas were ever shipped |

### bun

| bun semver | `bun-text` | `bun-binary` | Notes |
|------------|-----------|--------------|-------|
| `<1.1`     | – | – (detect-only) | bun emits binary only; library detects + rejects |
| `>=1.1 <1.2` | RW (opt-in) | – (detect-only) | text via `--save-text-lockfile` |
| `>=1.2`    | RW (default) | – (detect-only) | text default; legacy binary in repos still detected |

`bun-binary` is a **permanent non-goal** — see
[`bun-binary.md`](./bun-binary.md). Users with `bun.lockb` files must
migrate via `bun install --save-text-lockfile` (bun-side; the library
does not shell out).

> **Open:** several "opt-in" rows above are educated guesses about the exact
> CLI flags and PM versions where the capability appeared. Validate each one
> in the test bench and tighten the semver ranges.

> **Open:** the pnpm `lockfileVersion` ↔ pnpm-major mapping is non-linear:
> pnpm 6 wrote `5.3`, pnpm 7 stayed on `5.4` by default, pnpm 8 introduced
> `6.0` / `6.1`, pnpm 9 *jumped* to `9.0` (no 7 or 8 schema was ever
> shipped). The spec collapses minor sub-version bumps into one adapter
> per major schema family; the producer table in each pnpm doc enumerates
> exact versions seen in the wild.

> **Open:** id naming consistency. Right now `npm-N` uses lockfileVersion,
> `yarn-berry-vN` uses `__metadata.version`, `yarn-classic` is by name,
> `pnpm-vN` is by lockfileVersion-major, `bun-*` is by encoding. Possible
> tidier scheme: `<pm>-<schemaIdentifier>` everywhere, with `yarn-1` reserved
> for classic by convention. Decide before public release.
