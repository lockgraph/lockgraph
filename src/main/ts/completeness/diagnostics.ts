import type { Diagnostic } from '../graph.ts'

export type PackageMetadataDiagnosticCode =
  | 'COMPLETENESS_PACKAGE_METADATA_INCOMPLETE'
  | 'COMPLETENESS_PACKAGE_METADATA_MISMATCH'
  | 'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED'

export function packageMetadataDiagnostic(
  code: PackageMetadataDiagnosticCode,
  subject: string,
  message: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: 'warning',
    subject,
    message,
    data: Object.freeze({ dimension: 'packageMetadata', subject }),
  })
}
