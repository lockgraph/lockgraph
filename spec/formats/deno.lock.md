# `deno.lock` — Deno's native lockfile

> Status: frontier (research-grade; no adapter yet — see #63).
> Updated: 2026-06-16.
> Provenance: **External** — Deno's native lockfile; not yet parsed/emitted here.

A frontier **stub**. `deno.lock` is NOT yet read or written by this library
(the Deno adapter is a planned frontier effort, #63). This records what is
known — from the behavior doc [`spec/pm/deno.md`](../pm/deno.md) and the
registry contracts [`spec/registry/jsr.md`](../registry/jsr.md) +
[`spec/registry/npm.md`](../registry/npm.md) — so a future adapter + full spec
can be built. It is a placeholder, **not a contract**.

## What is known (research-grade — verify before implementing)

- **Versions.** A JSON document with a top-level `version` field; observed `v1`
  → `v5` across Deno 1.x → 2.x. The schema shifts materially between versions
  (e.g. v3→v4 restructuring, v5 added metadata).
- **Dual integrity model — do NOT normalise across it.**
  - `remote` + `jsr` entries → bare lowercase-hex **sha256**.
  - `npm` entries → **sha512** SRI (`sha512-…`), the npm-registry shape.
  These are two distinct hash schemes in one file (cf.
  [`_common.md`](./_common.md) integrity model).
- **Sections (version-dependent).** `remote` (URL → hash), `jsr`
  (`@scope/name@ver` → {integrity, dependencies}), `npm` (npm specifier →
  {integrity, dependencies}), newer `workspace`/`packages`, and a top-level
  `specifiers` map (import-map-style resolution pins).
- **Identity is naming-based, not layout-based.** Keyed by URL / `jsr:` / `npm:`
  specifier — there is no `node_modules` path identity. Deno's resolver replaces
  the Node `node_modules` walk (see [`spec/pm/deno.md`](../pm/deno.md) §3).

## Open (frontier)

- The byte-exact `v4` vs `v5` schema delta is not pinned (corpora-derived, no
  live probe).
- The full `npm`-section sub-shape and `--allow-scripts` persistence are
  unverified.
- No adapter, no round-trip tests yet (#63).
