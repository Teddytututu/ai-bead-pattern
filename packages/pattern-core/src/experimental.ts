export {
  validateCandidateMetricsV2,
  validateCanvasPlan,
  validatePalettePlan,
  validateStructurePlan,
  validateValuePlan,
} from './contracts.js'
export type {
  CandidateMetricsV2,
  CanvasPlan,
  CanvasPlanScore,
  ColorRole,
  FeatureBudget,
  FeatureConstraint,
  MetricValue,
  OccupancyMode,
  PalettePlan,
  StructurePlan,
  StructureRegion,
  ValuePlan,
  ValueRole,
  ValueRoleKind,
} from './contracts.js'
export {
  buildSourceShapeModel,
  rasterizeSourceShape,
  shapeRasterizationThreshold,
} from './shape.js'
export { planCanvases } from './planning/canvas-planner.js'
export type { CanvasPlanningInput } from './planning/canvas-planner.js'
export {
  featureTemplateLibrary,
  selectFeatureTemplates,
} from './planning/feature-template-library.js'
export { validateFeatureTemplate } from './planning/feature-template.js'
export type {
  FeatureCellRole,
  FeatureTemplate,
  FeatureTemplateCell,
  FeatureTemplateKind,
} from './planning/feature-template.js'
export type { FeatureTemplateSelection } from './planning/feature-template-library.js'
export {
  createFeatureConstraint,
  searchFeaturePlacements,
  validateResolvedFeaturePlacement,
} from './planning/feature-placement.js'
export type {
  FeaturePlacementSearchInput,
  ResolvedFeaturePlacement,
} from './planning/feature-placement.js'
export { searchFeaturePairs } from './planning/feature-pair-search.js'
export type {
  FeaturePairSearchInput,
  ResolvedFeaturePair,
} from './planning/feature-pair-search.js'
export { resolveFeatureColors } from './planning/feature-color-resolver.js'
export type {
  FeatureColorResolutionInput,
  FeatureColorResolutionResult,
} from './planning/feature-color-resolver.js'
export type {
  LandmarkAllocation,
  ShapeAnchor,
  ShapeBounds,
  ShapeComponent,
  ShapeContour,
  ShapeDiagnostics,
  ShapePoint,
  ShapeRasterization,
  ShapeRasterizationOptions,
  SourceShapeModel,
} from './shape.js'
