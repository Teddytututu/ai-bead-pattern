/** Shared discovery surface for the pure planning stages used by pattern-core. */
export {
  hasConfidentSubjectMask,
  resolveDistanceMethod,
  resolveOccupancyModes,
  resolveResizeMethod,
  resolveSizes,
  resolveStyles,
  resolvedCrop,
  styleColorLimit,
  withoutSubjectMask,
} from './generation-policy.js'
export {
  planCanvases,
  planCanvasesWithShapeVariants,
} from './canvas-planner.js'
export {
  createFeatureConstraint,
  searchFeaturePlacements,
  validateResolvedFeaturePlacement,
} from './feature-placement.js'
export { searchFeaturePairs } from './feature-pair-search.js'
export { planFeaturePlacements, plannedFeatureConstraints, protectedCells } from './feature-planner.js'
export { resolveFeatureColors } from './feature-color-resolver.js'
export { buildStructurePlan } from './structure-planner.js'
export { buildValuePlan } from './value-planner.js'
export { buildPalettePlan } from './palette-planner.js'
export { enforcePaletteInventory, quantizePalette } from './palette-quantizer.js'

export type { ResolvedOccupancyMode } from './generation-policy.js'
export type {
  CanvasPlanningInput,
} from './canvas-planner.js'
export type {
  FeaturePlacementSearchInput,
  ResolvedFeaturePlacement,
} from './feature-placement.js'
export type {
  FeaturePairSearchInput,
  ResolvedFeaturePair,
} from './feature-pair-search.js'
export type {
  FeatureColorResolutionInput,
  FeatureColorResolutionResult,
} from './feature-color-resolver.js'
export type { StructurePlanningInput } from './structure-planner.js'
export type {
  MaterialValueKind,
  ValuePlanningInput,
  ValuePlanningResult,
} from './value-planner.js'
export type {
  PalettePlanningDiagnostics,
  PalettePlanningInput,
  PalettePlanningResult,
  PaletteSubstitutionDiagnostic,
} from './palette-planner.js'
export type {
  PaletteQuantizationInput,
  PaletteQuantizationResult,
  PaletteInventoryRepairInput,
  PaletteInventoryRepairResult,
} from './palette-quantizer.js'
