import esbuild from 'rollup-plugin-esbuild'
import { builtinModules } from 'node:module'

// Runtime deps stay EXTERNAL (the consumer installs them); only the library's
// own `src/main/ts` modules are emitted.
const pkgDeps = ['semver', 'pako', 'node-fetch-native']
const external = (id) =>
  id.startsWith('node:') ||
  builtinModules.includes(id) ||
  pkgDeps.some((d) => id === d || id.startsWith(`${d}/`))

const SRC = 'src/main/ts'
const adapters = [
  'bun-text',
  'npm-1', 'npm-2', 'npm-3',
  'pnpm-v5', 'pnpm-v6', 'pnpm-v9',
  'yarn-berry-v4', 'yarn-berry-v5', 'yarn-berry-v6', 'yarn-berry-v7',
  'yarn-berry-v8', 'yarn-berry-v9', 'yarn-berry-v10',
  'yarn-classic',
  'lockgraph',
]

// One input per package.json `exports` subpath; preserveModules emits the whole
// reachable module tree at its real source-mirrored path (no hashed chunks).
const input = [
  `${SRC}/index.ts`,
  `${SRC}/modify/index.ts`,
  `${SRC}/complete/index.ts`,
  `${SRC}/optimize/index.ts`,
  `${SRC}/registry/index.ts`,
  `${SRC}/enrich/index.ts`,
  ...adapters.map((id) => `${SRC}/formats/${id}.ts`),
]

export default {
  input,
  external,
  plugins: [
    esbuild({ target: 'node14', minify: true, tsconfig: './tsconfig.json' }),
  ],
  output: {
    dir: 'dist',
    format: 'esm',
    preserveModules: true,
    preserveModulesRoot: SRC,
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name].js',
  },
}
