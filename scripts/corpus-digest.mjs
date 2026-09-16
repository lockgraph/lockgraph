#!/usr/bin/env node

// Corpus replay digest — the gate for any refactor that is supposed to change nothing.
//
// For every lockfile in the local corpora it runs the same-format round trip and folds
// the results into one digest per corpus. A refactor that preserves behaviour leaves all
// of them byte-identical; a single changed hex digit is a defect until proven otherwise,
// and the per-file sidecar says which files moved.
//
// This exists because the test suite does not catch this class. On 2026-08-29 a
// legacy-tree extraction passed 751 green npm tests while dropping `resolved`+`integrity`
// from nine entries and deleting a whole nested package; two files of 1,828 changed. The
// digests caught both in under a minute.
//
//   npm run test:digest                  same-format replay, the five digests
//   npm run test:digest -- --to lockgraph  project every corpus into `lockgraph` — the only
//                                          format that prints `+src=`, so the only one that
//                                          sees a NodeId / source-discriminator change
//   npm run test:digest -- --out <dir>   also write per-file digests for localization
//   npm run test:digest -- --corpus npm  one corpus only
//
// It gates the ARTIFACT, not the source: it imports the built package by name through the
// real `exports` map, so `npm run build:dist` must have run. And it pins the CALL, not just
// the artifact — a prior measurement campaign was invalidated for two days because it fed a
// public graph into the `@internal` target-first serializer. The two calls below are the
// DOCUMENTED public order and must not be changed without re-pinning every value:
//
//   parse(input, format)                      NOT parse(format, input)      — pre-0.6 internal
//   stringify(graph, format, { strict: false }) NOT stringify(format, graph) — pre-0.6 internal
//
// Each row carries the lenient emit's sha256 AND the strict emit's outcome, so the digest
// moves both when a byte changes and when the strictness gate starts refusing (or accepting)
// a different set of locks.
//
// Corpora live under `tmp/*-corpus` and are NOT tracked; the file counts below are part of
// the pin, so a digest compared against a differently-sized corpus proves nothing. Re-pin
// after any corpus refresh.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse, stringify, detect } from 'lockgraph'

const CORPORA = {
  npm:  'tmp/npm-corpus',
  pnpm: 'tmp/pnpm-corpus',
  yarn: 'tmp/yarn-corpus',
  bun:  'tmp/bun-corpus',
  deno: 'tmp/deno-corpus',
}

const MAX_BYTES = 40 * 1024 * 1024

// Provenance header fields, normalized out of every emit before hashing. Add a key here
// when the format gains one; leaving it out silently moves all five digests at once.
const PROVENANCE_KEYS = ['generatedAt', 'generator']

const argv = process.argv.slice(2)
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const outDir = argOf('--out')
const only = argOf('--corpus')
// Same-format replay is blind to anything the target does not print. `lockgraph` is the
// only format that writes `Node.source` — the `+src=` discriminator — verbatim, so
// `--to lockgraph` is the complement that sees an identity change at all. Pin both.
const to = argOf('--to')

function* walk(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function replay(root, target) {
  const rows = []
  const reasons = new Map()
  const note = (key) => reasons.set(key, (reasons.get(key) ?? 0) + 1)
  let files = 0

  for (const path of walk(root)) {
    if (statSync(path).size > MAX_BYTES) { note('skipped:oversize'); continue }
    files++
    let input
    try { input = readFileSync(path, 'utf8') } catch { note('skipped:unreadable'); continue }

    let format
    try { format = detect(input) } catch { note('skipped:detect-threw'); continue }
    if (format === undefined) { note('skipped:undetected'); continue }

    let graph
    try { graph = parse(input, format) } catch (error) {
      note(`parse-failed:${error?.code ?? error?.name ?? 'Error'}`)
      continue
    }

    // Two emits per file, and BOTH are pinned. The lenient one is what the digest
    // hashes, so npm-1 — which cannot express the canonical graph in its nested tree,
    // and refuses under `strict` for 201 corpus locks — stays inside the gate instead
    // of falling out of it. The strict outcome rides the same row, so a change in what
    // the strictness gate refuses moves the digest exactly like a changed byte does.
    const emitAs = target ?? format
    let output
    try { output = stringify(graph, emitAs, { strict: false }) } catch (error) {
      note(`emit-failed:${error?.code ?? error?.name ?? 'Error'}`)
      continue
    }
    // `lockgraph` carries a provenance header — a wall-clock `generatedAt` today, the
    // generator version next — and that is deliberate: it is our own interchange format,
    // not a lockfile a package manager freezes. It does mean two emits of the same graph
    // differ, so a byte gate MUST normalize the whole provenance block, not one line, or
    // it breaks again the moment a field is added. Normalize by key, and only these keys;
    // every other byte is signal.
    for (const key of PROVENANCE_KEYS) {
      output = output.replace(new RegExp(`^${key} .*$`, 'mu'), `${key} <normalized>`)
    }

    let strictOutcome = 'ok'
    try { stringify(graph, emitAs) } catch (error) {
      strictOutcome = `refused:${error?.code ?? error?.name ?? 'Error'}`
    }
    note(`strict:${strictOutcome}`)
    rows.push(`${relative(root, path)}\0${format}\0${strictOutcome}\0${sha256(output)}`)
  }

  rows.sort()
  return {
    files,
    replayed: rows.length,
    digest: createHash('md5').update(rows.join('\n')).digest('hex'),
    reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    rows,
  }
}

const head = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
})()
const artifact = (() => {
  try { return sha256(readFileSync('dist/index.js')).slice(0, 16) }
  catch { return 'MISSING — run `npm run build:dist` first' }
})()

console.log(`corpus-digest  HEAD ${head}  dist/index.js sha256:${artifact}`)
console.log(`call           parse(input, format) -> stringify(graph, ${to === undefined ? 'format' : JSON.stringify(to)}, { strict: false })  [+ strict outcome per row]`)
console.log(`normalized     provenance header keys: ${PROVENANCE_KEYS.join(', ')} — every other byte is signal`)
console.log('')

let exitCode = 0
for (const [name, root] of Object.entries(CORPORA)) {
  if (only !== undefined && only !== name) continue
  let present = true
  try { statSync(root) } catch { present = false }
  if (!present) {
    console.log(`${name.padEnd(5)} CORPUS MISSING at ${root} — this corpus is not gated`)
    exitCode = 1
    continue
  }
  const result = replay(root, to)
  console.log(
    `${name.padEnd(5)} files ${String(result.files).padStart(5)}`
    + `  replayed ${String(result.replayed).padStart(5)}`
    + `  ${result.digest}`,
  )
  for (const [reason, count] of result.reasons) console.log(`${''.padEnd(6)}${reason} ${count}`)
  if (outDir !== undefined) {
    mkdirSync(resolve(outDir), { recursive: true })
    writeFileSync(join(resolve(outDir), `${name}.tsv`), result.rows.join('\n') + '\n')
  }
}
if (outDir !== undefined) console.log(`\nper-file digests written to ${resolve(outDir)}`)
process.exit(exitCode)
