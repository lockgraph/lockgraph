// Public surface —.
// Terminal facade only: internal modules import lower-level authorities directly.

import { configureGraphAccessors } from './graph.ts'
import { overridesOf as graphOverrides } from './api/format-api.ts'
import { governingOverrideFor as graphGoverningOverride } from './recipe/descriptor-resolve.ts'
import { registryPackages as graphRegistryPackages } from './optimize/registry-packages.ts'

configureGraphAccessors({
  overrides: graphOverrides,
  governingOverride: (graph, name, consumerPath, declaredRange) =>
    graphGoverningOverride(name, consumerPath, graphOverrides(graph), declaredRange),
  registryPackages: graphRegistryPackages,
})

export * from './api/public/index.ts'
