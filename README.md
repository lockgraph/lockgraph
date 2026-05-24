# @antongolub/lockfile

> Universal lockfile model and converter for **npm**, **yarn**, **pnpm**, **bun**.

<p><img alt="@antongolub/lockfile — universal lockfile model and converter for npm, yarn, pnpm, bun" src="./pics/lockfile.svg" align="right" width="300">

Each package manager brings its own philosophy of how to describe, store and
control project dependencies. It looks acceptable to a developer staring at a
single repo, but it becomes a real headache for IS, DevOps and release
engineers — and impossible for any tool that needs to reason about
dependency graphs across the ecosystem.

This library models the dependency graph independent of any specific
package manager, then projects it back into the format you need.
Conversion is one use case; modification (audit-fix, override pinning,
license filtering) is the headline.

</p>

## Status

🔒 **Contract preview, implementation in progress.** The public API
(`parse` / `stringify`) is locked. Adapter implementations are landing
incrementally — see [SCHEMAS.md](./SCHEMAS.md) for what's recognised.
Not yet published; `npm install` will appear once the first adapters
ship end-to-end.

## Concept

A target lockfile is **constructed** from facts gathered across whatever
sources are available: the input lockfile bytes, project `package.json`s,
the package-manager cache, and (opt-in) the registry. The simplest case is
*conversion* — parse one format, stringify another. The general case is
*construction*: assemble what the target requires from whichever source can
supply it.

Three layers, never collapsed:

- **Manifest** — declared constraints from `package.json`(s).
- **Graph** — resolved package instances (peer-aware) and the edges
  between them. The canonical internal model. Modifiers operate here.
- **Layout** — physical projection on disk: hoisted, isolated (pnpm-style),
  PnP, nm-linked.

Conversion is **lossy by design**. We aim for *semantically equivalent*,
not *byte-identical*. Irreducible facts (integrity hashes, resolution URLs,
signatures) are the exception — they are never silently lost.

## API

```ts
import { parse, stringify } from '@antongolub/lockfile'

const lf  = parse(rawLockfileBytes)
const str = stringify(lf, { format: 'npm-3' })
```

Two top-level operations, modelled on `JSON.parse` / `JSON.stringify`:

```ts
parse(input: string | Uint8Array, options?: ParseOptions): Lockfile

stringify(lockfile: Lockfile, options: StringifyOptions): string
```

- `parse` auto-detects the format by content sniffing. Pass
  `{ format: '<id>' }` to skip detection. Pass `{ manifests }` for
  formats that need extra workspace context (notably `yarn-classic`).
- `stringify`'s `options.format` is **required** — there is no implicit
  "same as parsed". Round-tripping is an explicit choice the caller makes.

`Lockfile` is the public alias for the internal canonical-graph type.
`FormatId` is a string-literal union — see
[SCHEMAS.md](./SCHEMAS.md) for the full list.

### Options

```ts
type ParseOptions = {
  format?:     FormatId          // skip auto-detect
  manifests?:  Manifests         // package.jsons keyed by workspace path
  pmConfig?:   PmConfig          // .npmrc / .yarnrc.yml / pnpm-workspace.yaml / bunfig.toml
  installDir?: string            // path to node_modules / .pnp.cjs (refinement)
  cache?:      CacheAdapter      // PM cache (refinement)
  registry?:   RegistryAdapter   // network access (opt-in)
}

type StringifyOptions = {
  format:        FormatId        // required
  manifests?:    Manifests
  pmConfig?:     PmConfig
  installDir?:   string
  cache?:        CacheAdapter
  registry?:     RegistryAdapter
  onDiagnostic?: (d: Diagnostic) => void
}
```

`pmConfig` / `installDir` / `cache` / `registry` are progressive
**refinement opt-ins**: each unlocks more information at higher cost. The
default succeeds offline, against the lockfile bytes (and `manifests`)
alone.

### Sub-imports

| Surface | Importable as | Contains |
|---------|---------------|----------|
| Root | `@antongolub/lockfile` | `parse`, `stringify`, plus types: `Lockfile`, `FormatId`, `ParseOptions`, `StringifyOptions`, `Manifest`, `Manifests` |
| Modifiers | `@antongolub/lockfile/modify` | audit-fix, override-pin, license-filter |
| Registry | `@antongolub/lockfile/registry` | adapters for live npm, file cache, frozen-from-lockfile |
| Per-format | `@antongolub/lockfile/formats/<id>` | direct access to a single adapter (test surface; not a primary user API) |

### Errors

`parse` / `stringify` throw a single `LockfileError` discriminated by
`code`:

```ts
'PARSE_FAILED' | 'FORMAT_DETECT_FAILED' | 'FORMAT_MISMATCH'
| 'CAPABILITY_LACK' | 'MISSING_MANIFEST'
| 'IRREDUCIBLE_LOSS' | 'INVARIANT_VIOLATION'
```

Reducible losses (e.g. dropped patches when emitting `npm-1` from a
yarn-berry source) surface as `Diagnostic` events via the
`onDiagnostic` callback, not exceptions.

## Schemas

Every recognised lockfile schema is enumerated in
[SCHEMAS.md](./SCHEMAS.md), with adapter ids, the schema-marker each
carries, the package-manager versions that emit it by default, and
permalinked sources. Use that table as the index when calling
`parse({ format })` or `stringify({ format })`.

## Predecessor and inspirations

This project is the architectural successor to
[`yarn-audit-fix`](https://github.com/antongolub/yarn-audit-fix), generalised
beyond yarn.

Earlier work in this space:

- [synp](https://github.com/imsnif/synp)
- [snyk-nodejs-lockfile-parser](https://github.com/snyk/nodejs-lockfile-parser)
- [`@yarnpkg/lockfile`](https://github.com/yarnpkg/yarn/tree/master/packages/lockfile)
- [`pnpm/lockfile-utils`](https://github.com/pnpm/pnpm/tree/main/lockfile)

## Package-manager docs

- [`package-lock.json`](https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json)
  — npm
- [yarn lockfile (classic)](https://classic.yarnpkg.com/lang/en/docs/yarn-lock/)
  / [yarn lockfile (berry)](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts)
- [`pnpm/spec/lockfile/`](https://github.com/pnpm/spec/tree/master/lockfile)
  — pnpm
- [bun lockfile](https://bun.com/docs/pm/lockfile) — bun

## Compatibility

- **Node ≥ 20.** No browser build planned.
- **ESM only.** Consumers on CommonJS use dynamic `await import(…)`.

## License

[MIT](./LICENSE)
