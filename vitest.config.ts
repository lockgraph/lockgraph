import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    exclude: ['node_modules/**'],
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
      all: true,   // count untested source files too (0%), not just imported ones
    },
  },
})
