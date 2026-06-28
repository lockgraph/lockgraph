#!/usr/bin/env node
// Rewrite relative `.ts` import/export specifiers to `.js` in the emitted
// declarations. tsc keeps the source `.ts` extensions (the project uses
// `allowImportingTsExtensions`); the shipped `.d.ts` must point at the emitted
// `.js`. Same post-process as google/zx's build-dts.
import { readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

const DIST = 'dist'
const files = readdirSync(DIST, { recursive: true })
let fixed = 0
for (const rel of files) {
  if (!rel.endsWith('.d.ts')) continue
  const path = `${DIST}/${rel}`
  const src = await readFile(path, 'utf8')
  const out = src
    .replace(/(\bfrom\s*['"]\.[^'"]*)\.ts(['"])/g, '$1.js$2')
    .replace(/(\bimport\(['"]\.[^'"]*)\.ts(['"]\))/g, '$1.js$2')
  if (out !== src) { await writeFile(path, out); fixed++ }
}
console.log(`fix-dts: rewrote .ts→.js specifiers in ${fixed} declaration files`)
