import type {
  OperationSources as InternalOperationSources,
  ProjectionOptions as InternalProjectionOptions,
} from '../operation.ts'
import type { EnrichSources as InternalEnrichSources } from '../../enrich/facade.ts'
import { internalObserver } from './diagnostics.ts'
import { internalPmConfig } from './assessment.ts'
import { internalRegistry } from './registry.ts'
import type {
  OperationSources,
  ProjectionOptions,
} from './operation.ts'

/** @internal Converts structured 0.6 sources to the existing execution core. */
export function internalSources(
  value: OperationSources | undefined,
): InternalOperationSources | undefined {
  if (value === undefined) return undefined
  return {
    ...(value.manifests === undefined ? {} : { manifests: value.manifests }),
    ...(value.policy === undefined ? {} : { policy: internalPmConfig(value.policy) }),
    ...(value.packuments === undefined
      ? {}
      : { packuments: value.packuments.map(internalRegistry) }),
    ...(value.artifacts === undefined
      ? {}
      : { artifacts: value.artifacts as InternalOperationSources['artifacts'] }),
  }
}

/** @internal Same source adapter with the enrich core's extended legacy type. */
export function internalEnrichSources(
  value: OperationSources | undefined,
): InternalEnrichSources | undefined {
  return internalSources(value) as InternalEnrichSources | undefined
}

/** @internal Converts the common public option spine at one operation boundary. */
export function internalProjectionOptions(value: ProjectionOptions): InternalProjectionOptions {
  return {
    target: value.target,
    ...(value.registry === undefined ? {} : { registry: value.registry }),
    ...(value.sources === undefined ? {} : { sources: internalSources(value.sources) }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.guards === undefined
      ? {}
      : { guards: value.guards as InternalProjectionOptions['guards'] }),
    ...(value.store === undefined ? {} : { store: value.store }),
    ...(value.strict === undefined ? {} : { strict: value.strict }),
    ...(value.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: internalObserver(value.onDiagnostic) }),
  }
}
