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
export { buildStructurePlan } from './planning/structure-planner.js'
export type { StructurePlanningInput } from './planning/structure-planner.js'
export { buildValuePlan } from './planning/value-planner.js'
export type {
  MaterialValueKind,
  SemanticGapDiagnostic,
  SemanticValueGaps,
  ValueGroupDiagnostic,
  ValueLighting,
  ValuePlanningDiagnostics,
  ValuePlanningInput,
  ValuePlanningResult,
} from './planning/value-planner.js'
export { buildPalettePlan } from './planning/palette-planner.js'
export type {
  PalettePlanningDiagnostics,
  PalettePlanningInput,
  PalettePlanningResult,
  PaletteSubstitutionDiagnostic,
} from './planning/palette-planner.js'
export { refineGridClusters } from './grid-refinement.js'
export type {
  GridRefinementInput,
  GridRefinementResult,
} from './grid-refinement.js'
export type {
  GridBudgetViolations,
  GridClusterDiagnostics,
  GridRefinementBudgets,
  GridRefinementMode,
  GridRefinementSummary,
} from './types.js'
export { fitBradleyTerry, predictPairwisePreference } from './preference.js'
export {
  applyArtDirectionImportance,
  enforceTileSeams,
  planPixelArtDirection,
  selectAnimationKeyFrame,
} from './art-direction.js'
export type {
  AnimationFrameCandidate,
  AnimationKeyFrameSelection,
  ArtDirectionExecutionSummary,
  ArtDirectionImportanceInput,
  ArtDirectionImportanceResult,
  ArtDirectionImportanceSummary,
  MaterialDirectionProfile,
  PixelArtDirectionInput,
  PixelArtDirectionPlan,
  PixelArtMode,
  SceneLayerId,
  TileSeamInput,
  TileSeamResult,
  TileSeamSummary,
  TextureDirection,
} from './art-direction.js'
export type {
  BradleyTerryOptions,
  BradleyTerryResult,
  CandidatePreferenceScore,
  PairwisePreferenceChoice,
  PairwisePreferenceRecord,
} from './preference.js'
export {
  BASELINE_PREFERENCE_WEIGHTS,
  PREFERENCE_AXES,
  PREFERENCE_FEATURES,
  PREFERENCE_ISSUES,
  PREFERENCE_RECORD_SCHEMA_VERSION,
  comparePreferenceModels,
  createFrozenPreferenceSplit,
  deduplicatePreferenceRecords,
  derivePreferenceGenerationParameters,
  fitPreferenceModelV2,
  migratePairwisePreferenceRecord,
  normalizePreferenceRecordV2,
  preferenceRecordFromWorkbenchSession,
  preferenceRecordFingerprint,
  rankPreferenceCandidates,
  replayPreferenceRecord,
  selectActivePreferencePair,
  selectPreferenceModelVersion,
  validatePreferenceRecordV2,
} from './preference-v2.js'
export type {
  ActivePreferencePairOptions,
  ActivePreferencePair,
  ComparedPreferencePair,
  FrozenPreferenceSplit,
  FrozenPreferenceSplitOptions,
  PreferenceAxis,
  PreferenceAxisScores,
  PreferenceAnnotatorIdentity,
  PreferenceCandidateRankScore,
  PreferenceCandidateRoute,
  PreferenceCandidateV2,
  PreferenceCellSelection,
  PreferenceCompositeChoice,
  PreferenceComparisonV2,
  PreferenceElimination,
  PreferenceEvaluationMetrics,
  PreferenceFeatureName,
  PreferenceFeatureVector,
  PreferenceGenerationAdjustments,
  PreferenceGenerationParameters,
  PreferenceIssue,
  PreferenceIssueAnnotation,
  PreferenceModelComparison,
  PreferenceModelContext,
  PreferenceModelIdentity,
  PreferenceModelOptions,
  PreferenceModelSelection,
  PreferenceModelSelectionOptions,
  PreferenceModelV2,
  PreferenceRankingResult,
  PreferenceRecordV2,
  PreferenceRegionSelection,
  PreferenceReplayResult,
  PreferenceSourceIdentity,
  PreferenceStratumModel,
  PreferenceSubjectKind,
  PreferenceV1MigrationContext,
  PreferenceWorkbenchConversionOptions,
} from './preference-v2.js'
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
