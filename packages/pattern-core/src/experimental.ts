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
} from './shape.js'
export { planCanvases } from './planning/canvas-planner.js'
export type { CanvasPlanningInput } from './planning/canvas-planner.js'
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
