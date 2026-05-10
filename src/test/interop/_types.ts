// Shared primitive types used by both `_matrix.ts` (contract definitions) and
// `_fixtures.ts` (corpus disk-loader). Kept here so neither module needs to
// import the other; matrix and fixtures both depend down on this leaf module.

export type FormatId =
  | 'yarn-berry-v4'
  | 'yarn-berry-v5'
  | 'yarn-berry-v6'
  | 'yarn-berry-v8'
  | 'yarn-berry-v9'
  | 'yarn-classic'
  | 'npm-1'
  | 'npm-2'
  | 'npm-3'
  | 'pnpm-v5'
  | 'pnpm-v6'
  | 'pnpm-v9'
  | 'bun-text'
