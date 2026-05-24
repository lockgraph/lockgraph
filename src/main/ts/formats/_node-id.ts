// Shared cross-format `NodeId` parsing helpers.
//
// Canonical `NodeId` shape per ADR-0006 / ADR-0017:
//   `<name>@<version>` — scoped names keep their leading `@`;
//   peer-context suffix `(<peer>)*` appended at depth 0.
//
// These helpers operate on the raw string form before Graph node lookup —
// used at parse time when the member node is not yet accessible via the
// builder (e.g. F4 workspaceRange.resolvedVersion derivation).

/**
 * Extract the version slot from a canonical NodeId `<name>@<version>`
 * — scoped names keep their leading `@`. Returns `undefined` if the id
 * lacks a depth-0 `@` separator. Peer-context parentheses are stripped
 * from the trailing slot.
 */
export function nodeVersionOf(id: string): string | undefined {
  let depth = 0
  let lastAt = -1
  for (let i = 0; i < id.length; i++) {
    const c = id[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '@' && depth === 0 && i > 0) lastAt = i
  }
  if (lastAt < 0) return undefined
  const rest = id.slice(lastAt + 1)
  const paren = rest.indexOf('(')
  return paren < 0 ? rest : rest.slice(0, paren)
}
