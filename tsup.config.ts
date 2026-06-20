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
  // Bundling: each entry self-contained — shared internals (errors.ts,
  // graph.ts, _yarn-syml.ts, _pnpm-yaml.ts, format cores) get inlined per
  // entry point. Trade some duplication on disk for predictable single-file
  // imports. Consumers usually import ONE adapter — no cascade of chunk loads.
  splitting: false,
  treeshake: true,
  shims:     false,
})
