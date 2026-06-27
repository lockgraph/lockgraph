import { defineConfig } from 'tsup'

// Build entries: root + one public entry per adapter (subpath imports).
// `_*.ts` core/helper modules are NOT direct entries — they get bundled
// into whichever adapter pulls them in.
const adapters = [
  'bun-text',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
  'yarn-classic',
  // Native graph-serialization format (#101). Declared in package.json
  // `exports` (`./formats/lockgraph`) and imported by index.ts, so it needs
  // its own entry file — previously omitted here, which left the subpath
  // export unresolvable (no dist/formats/lockgraph.js emitted).
  'lockgraph',
]

export default defineConfig({
  entry: {
    index:    'src/main/ts/index.ts',
    // ADR-0023 §8.2 — modification subpath publishes the modifier vocabulary
    // (`@antongolub/lockfile/modify`) and the completion subpath publishes the
    // tree-completion + find-up algorithms (`@antongolub/lockfile/complete`).
    // Phase D-A — `@antongolub/lockfile/registry` publishes both the offline
    // `frozenRegistry` reference impl and the HTTPS-backed `liveRegistry`.
    modify:   'src/main/ts/modify/index.ts',
    complete: 'src/main/ts/complete/index.ts',
    optimize: 'src/main/ts/optimize/index.ts',
    registry: 'src/main/ts/registry/index.ts',
    // ADR-0034 — `@antongolub/lockfile/enrich` publishes the install-completeness
    // phase (`refurbish`), which recomputes the yarn-berry `checksum`.
    enrich:   'src/main/ts/enrich/index.ts',
    ...Object.fromEntries(
      adapters.map(id => [`formats/${id}`, `src/main/ts/formats/${id}.ts`]),
    ),
  },
  format:    ['esm'],
  dts:       true,
  clean:     true,
  outDir:    'dist',
  // Floor is Node 14.18 (the `node:` import-prefix introduced there); the
  // codebase uses no runtime API above 14 and no `import.meta`. esbuild
  // down-levels syntax to this target. CI still tests 20/22/24.
  target:    'node14',
  sourcemap: false,
  // ESM code-splitting: shared internals (errors.ts, graph.ts, the recipe/*
  // layer, and the big format cores — _yarn-berry-core.ts (~149 kB src),
  // _pnpm-flat-core.ts, _npm-core.ts) are hoisted into hashed shared chunks
  // imported by each entry, instead of being inlined into every bundle.
  // Without this the 7 yarn-berry adapters each inlined a full copy of the
  // berry core (and index.js inlined the entire surface, ~418 kB), bloating
  // total dist well past the size-limit budget. All cross-module imports are
  // static and the cores hold no module-level mutable state, so splitting is
  // behaviour-preserving (ESM modules stay singletons). Consumers importing a
  // single adapter now pull a few shared chunks alongside it — a deliberate
  // disk-size-over-file-count trade, the inverse of the previous default.
  splitting: true,
  treeshake: true,
  shims:     false,
})
