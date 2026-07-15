#!/usr/bin/env node
// Rewrite relative `.ts` import/export specifiers to `.js` in the emitted
// declarations. tsc keeps the source `.ts` extensions (the project uses
// `allowImportingTsExtensions`); the shipped `.d.ts` must point at the emitted
// `.js`. Same post-process as google/zx's build-dts.
import { readdirSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DIST = 'dist'
const files = readdirSync(DIST, { recursive: true })
  .map(rel => rel.split('\\').join('/'))
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

// tsc emits declarations for every source file in the program, including
// implementation-only helpers that no published declaration can reach. Keep
// the package's declaration graph honest: start at package.json#exports type
// entries, follow relative declaration imports, and drop only files outside
// that transitive closure. Deep imports are denied by the exports map, so these
// files are not consumer surfaces; retaining them only inflates the tarball.
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const declarationFiles = files.filter(rel => rel.endsWith('.d.ts'))
const publicEntries = new Set()
const deniedExports = Object.entries(pkg.exports)
  .filter(([, target]) => target === null)
  .map(([specifier]) => specifier)
const matchesExportPattern = (pattern, specifier) => {
  if (!pattern.includes('*')) return pattern === specifier
  const [prefix, suffix] = pattern.split('*')
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
}

for (const [exportPattern, target] of Object.entries(pkg.exports)) {
  const pattern = target?.types
  if (typeof pattern !== 'string') continue
  const rel = pattern.replace(/^\.\/dist\//, '')
  if (!rel.includes('*')) {
    publicEntries.add(resolve(DIST, rel))
    continue
  }
  let matched = false
  const [prefix, suffix] = rel.split('*')
  for (const candidate of declarationFiles) {
    if (candidate.startsWith(prefix) && candidate.endsWith(suffix)) {
      const wildcard = candidate.slice(prefix.length, candidate.length - suffix.length)
      const specifier = exportPattern.replace('*', wildcard)
      if (deniedExports.some(denied => matchesExportPattern(denied, specifier))) continue
      publicEntries.add(resolve(DIST, candidate))
      matched = true
    }
  }
  if (!matched) throw new Error(`fix-dts: export ${exportPattern} matched no declarations`)
}

const reachable = new Set()
const pending = [...publicEntries].sort()
while (pending.length > 0) {
  const path = pending.shift()
  if (reachable.has(path)) continue
  reachable.add(path)
  const source = await readFile(path, 'utf8')
  const specifiers = [
    ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(['"]([^'"]+)['"]\)/g),
  ].map(match => match[1]).filter(specifier => specifier.startsWith('.'))
  for (const specifier of specifiers) {
    const dependency = resolve(
      dirname(path),
      specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.d.ts` : specifier,
    )
    if (!reachable.has(dependency)) pending.push(dependency)
  }
  pending.sort()
}

let pruned = 0
let prunedBytes = 0
for (const rel of declarationFiles) {
  const path = resolve(DIST, rel)
  if (reachable.has(path)) continue
  prunedBytes += (await stat(path)).size
  await unlink(path)
  pruned++
}
console.log(`fix-dts: pruned ${pruned} unreachable declaration files (${prunedBytes} bytes)`)
