// ADR-0023 — modify/ public re-exports.
//
// Six modifier primitives + their result types, the ModifyContext shape,
// the MODIFY_* diagnostic taxonomy, and helper factories. Per ADR §8.1
// directory layout.

export { addDependency, type AddableEdgeKind, type AddDependencyResult } from './add-dependency.ts'
export { applyPatch, type ApplyPatchResult, type ApplyPatchSpec } from './apply-patch.ts'
export { filterLicense, type FilterLicenseOptions, type FilterLicenseResult } from './filter-license.ts'
export { pinOverride, type PinOverrideResult } from './pin-override.ts'
export {
  removeDependency,
  type RemoveDependencyOptions,
  type RemoveDependencyResult,
} from './remove-dependency.ts'
export {
  replaceVersion,
  type ReplaceVersionOptions,
  type ReplaceVersionResult,
  type ReplaceVersionSelector,
} from './replace-version.ts'

export {
  resolveContext,
  type ModifyContext,
  type ModifyOptions,
} from './context.ts'

export {
  modifyEdgeRewired,
  modifyLicenseBlocked,
  modifyLicenseFlagged,
  modifyNodeAdded,
  modifyNodeRemoved,
  modifyNodeReplaced,
  modifyOverridePinned,
  modifyPatchApplied,
  modifyResolveFailed,
  modifySentinelRefused,
  type ModifyDiagnostic,
  type ModifyDiagnosticCode,
} from './diagnostics.ts'
