import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    exclude: ['node_modules/**'],
    // Real-world interop tests parse the full fixture corpus (42 published locks,
    // some very large) inside a single case. The 5s vitest default is too tight
    // on slow CI runners (surfaced on Node 26), so raise the ceiling. Fast tests
    // are unaffected — this only lifts the cap; genuine hangs still surface.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // html for humans, lcov for qlty, text for the CI log.
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'target/coverage',
      include: ['src/main/ts/**'],
      exclude: [
        'src/main/ts/**/types.ts',   // type-only — no runtime to cover
        'src/main/ts/**/*.d.ts',
        // subpath re-export barrels (public API surface, no logic)
        'src/main/ts/{modify,complete,optimize,registry,enrich}/index.ts',
      ],
    },
  },
})
