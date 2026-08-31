import type { GridEditRecord, ImageType, PatternStyle } from './types.js'

export type PixelArtMode = 'single' | 'tile' | 'animation-frame'
export type TextureDirection = 'none' | 'horizontal' | 'vertical' | 'grain' | 'radial' | 'flow' | 'weave'

export interface PixelArtDirectionInput {
  width: number
  height: number
  style: PatternStyle
  imageType: ImageType
  subjectOccupancy: number
  focus?: readonly [number, number]
  semanticLabels?: readonly string[]
  lightDirection?: readonly [number, number]
  depthRange?: readonly [number, number]
  mode?: PixelArtMode
  tileEdges?: Readonly<Record<'top' | 'right' | 'bottom' | 'left', string>>
  frame?: {
    poseVisibility: number
    actionArc: number
    sharedPaletteId: string
    sharedGridId?: string
  }
  beadDiameterMm?: number
}

export interface MaterialDirectionProfile {
  textureDirection: TextureDirection
  textureDensity: number
  highlightWidth: number
  reflectionStrength: number
}

export interface PixelArtDirectionPlan {
  profile: {
    id: string
    clusterScale: number
    edgeRhythm: number
    saturationCurve: number
    hueShiftStrength: number
  }
  focus: readonly [number, number]
  lightDirection: readonly [number, number]
  detailBudget: {
    identityCells: number
    silhouetteCells: number
    textureCells: number
    transitionCells: number
    negativeSpaceCells: number
  }
  transitionBudget: number
  dither: {
    patternDensity: number
    maximumColorSwitches: number
    localNoiseBudget: number
  }
  outline: {
    mode: 'selective'
    lightOpacity: number
    shadowOpacity: number
    maximumWidthCells: number
    openEdgeRatio: number
  }
  scene: {
    layers: readonly { id: 'background' | 'middle' | 'foreground'; detailFactor: number; valueSeparation: number }[]
    occlusionBudget: number
    perspectiveStrength: number
    depthOfFieldStrength: number
  }
  materials: Readonly<Record<'metal' | 'wood' | 'stone' | 'soil' | 'water' | 'glass' | 'cloth', MaterialDirectionProfile>>
  tile?: {
    seamSignature: string
    variantBudget: number
    cornerStateBudget: number
  }
  animation?: {
    sharedPaletteId: string
    sharedGridId: string
    keyFrameScore: number
    gridConsistencyWeight: number
    actionArcWeight: number
  }
  craft: {
    estimatedBeads: number
    boardWidthMm: number
    boardHeightMm: number
    fragilityPenalty: number
    sectionCount: number
  }
  generation: {
    valueLevels: 2 | 3 | 4
    maxColorFactor: number
    isolatedPixelPenalty: number
    stripePenalty: number
    aliasPenalty: number
    paletteCoherence: number
    edgeProtection: number
  }
}

const styleProfiles: Record<PatternStyle, PixelArtDirectionPlan['profile'] & {
  transitionFactor: number
  ditherDensity: number
  colorFactor: number
  valueLevels: 2 | 3 | 4
  outlineLight: number
  outlineShadow: number
}> = {
  simple: {
    id: 'clear-v1', clusterScale: 1.3, edgeRhythm: 0.9, saturationCurve: 0.95,
    hueShiftStrength: 0.08, transitionFactor: 0.35, ditherDensity: 0.03,
    colorFactor: 0.62, valueLevels: 2, outlineLight: 0.12, outlineShadow: 0.72,
  },
  faithful: {
    id: 'delicate-v1', clusterScale: 0.85, edgeRhythm: 0.74, saturationCurve: 1,
    hueShiftStrength: 0.14, transitionFactor: 0.72, ditherDensity: 0.08,
    colorFactor: 1, valueLevels: 3, outlineLight: 0.16, outlineShadow: 0.66,
  },
  cute: {
    id: 'retro-cute-v1', clusterScale: 1.05, edgeRhythm: 0.82, saturationCurve: 1.12,
    hueShiftStrength: 0.2, transitionFactor: 0.56, ditherDensity: 0.14,
    colorFactor: 0.78, valueLevels: 3, outlineLight: 0.18, outlineShadow: 0.7,
  },
  'high-contrast': {
    id: 'high-contrast-v1', clusterScale: 1.15, edgeRhythm: 0.94, saturationCurve: 1.2,
    hueShiftStrength: 0.18, transitionFactor: 0.42, ditherDensity: 0.06,
    colorFactor: 0.76, valueLevels: 3, outlineLight: 0.08, outlineShadow: 0.88,
  },
  soft: {
    id: 'soft-v1', clusterScale: 0.95, edgeRhythm: 0.64, saturationCurve: 0.82,
    hueShiftStrength: 0.1, transitionFactor: 0.78, ditherDensity: 0.05,
    colorFactor: 0.9, valueLevels: 3, outlineLight: 0.24, outlineShadow: 0.52,
  },
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function unitPoint(value: readonly [number, number] | undefined, fallback: readonly [number, number]) {
  if (value === undefined) return fallback
  if (value.length !== 2 || value.some((entry) => Number.isFinite(entry) === false)) {
    throw new RangeError('Pixel art direction point must contain two finite values')
  }
  return [clamp(value[0]!), clamp(value[1]!)] as const
}

function direction(value: readonly [number, number] | undefined) {
  if (value === undefined) return [-0.45, -0.9] as const
  if (value.length !== 2 || value.some((entry) => Number.isFinite(entry) === false)) {
    throw new RangeError('Pixel art light direction must contain two finite values')
  }
  const magnitude = Math.hypot(value[0], value[1])
  if (magnitude < 1e-6) return [-0.45, -0.9] as const
  return [value[0] / magnitude, value[1] / magnitude] as const
}

function materialProfiles(labels: ReadonlySet<string>): PixelArtDirectionPlan['materials'] {
  const selected = (name: string, density: number) => labels.has(name) ? density : density * 0.65
  return {
    metal: { textureDirection: 'vertical', textureDensity: selected('metal', 0.28), highlightWidth: 0.12, reflectionStrength: 0.92 },
    wood: { textureDirection: 'grain', textureDensity: selected('wood', 0.34), highlightWidth: 0.24, reflectionStrength: 0.18 },
    stone: { textureDirection: 'radial', textureDensity: selected('stone', 0.24), highlightWidth: 0.3, reflectionStrength: 0.12 },
    soil: { textureDirection: 'none', textureDensity: selected('soil', 0.18), highlightWidth: 0.34, reflectionStrength: 0.06 },
    water: { textureDirection: 'horizontal', textureDensity: selected('water', 0.32), highlightWidth: 0.1, reflectionStrength: 0.8 },
    glass: { textureDirection: 'vertical', textureDensity: selected('glass', 0.12), highlightWidth: 0.08, reflectionStrength: 0.95 },
    cloth: { textureDirection: 'weave', textureDensity: selected('cloth', 0.22), highlightWidth: 0.3, reflectionStrength: 0.14 },
  }
}

function tilePlan(input: PixelArtDirectionInput) {
  if ((input.mode ?? 'single') !== 'tile') return undefined
  const edges = input.tileEdges ?? { top: 'open', right: 'open', bottom: 'open', left: 'open' }
  const states = [edges.top, edges.right, edges.bottom, edges.left].map((entry) => entry.trim() || 'open')
  return {
    seamSignature: states.join('|'),
    variantBudget: Math.max(4, new Set(states).size * 4),
    cornerStateBudget: Math.max(4, new Set([`${states[0]}:${states[1]}`, `${states[1]}:${states[2]}`, `${states[2]}:${states[3]}`, `${states[3]}:${states[0]}`]).size),
  }
}

function animationPlan(input: PixelArtDirectionInput) {
  if ((input.mode ?? 'single') !== 'animation-frame') return undefined
  const frame = input.frame
  if (frame === undefined) throw new RangeError('Animation frame planning requires frame evidence')
  const pose = clamp(frame.poseVisibility)
  const arc = clamp(frame.actionArc)
  return {
    sharedPaletteId: frame.sharedPaletteId.trim() || 'shared-palette',
    sharedGridId: frame.sharedGridId?.trim() || `${input.width}x${input.height}`,
    keyFrameScore: clamp(pose * 0.65 + arc * 0.35),
    gridConsistencyWeight: clamp(0.8 + pose * 0.15),
    actionArcWeight: clamp(0.55 + arc * 0.4),
  }
}

export type SceneLayerId = 'background' | 'middle' | 'foreground'

export interface ArtDirectionImportanceInput {
  plan: PixelArtDirectionPlan
  width: number
  height: number
  activeMask: Uint8Array
  baseImportance: readonly number[]
  semanticLabelsByCell: readonly (string | undefined)[]
}

export interface ArtDirectionImportanceSummary {
  changedCells: number
  backgroundCompressedCells: number
  focusEnhancedCells: number
  maximumFocusBoost: number
  layerCells: Readonly<Record<SceneLayerId, number>>
}

export interface ArtDirectionImportanceResult {
  importance: readonly number[]
  summary: ArtDirectionImportanceSummary
}

export interface TileSeamInput {
  colorIds: readonly string[]
  width: number
  height: number
  activeMask: Uint8Array
  protectedCells: ReadonlySet<number>
  tileEdges: Readonly<Record<'top' | 'right' | 'bottom' | 'left', string>>
}

export interface TileSeamSummary {
  constrainedPairs: number
  mismatchesBefore: number
  mismatchesAfter: number
  seamEdits: number
  protectedConflicts: number
}

export interface TileSeamResult {
  colorIds: readonly string[]
  edits: readonly GridEditRecord[]
  summary: TileSeamSummary
}

export interface AnimationFrameCandidate {
  id: string
  silhouette: number
  featureVisibility: number
  actionArc: number
  blur: number
  occlusion: number
  sharedGridId: string
  sharedPaletteId: string
}

export interface AnimationKeyFrameSelection {
  selectedFrameId: string
  rankedFrameIds: readonly string[]
  scores: Readonly<Record<string, number>>
  sharedGridId: string
  sharedPaletteId: string
}

export interface ArtDirectionExecutionSummary {
  enabled: boolean
  importance: ArtDirectionImportanceSummary
  refinement?: {
    transitionCells: number
    ditherPatterns: number
    maximumColorSwitches: number
    localNoiseCells: number
    violationsBefore: number
    violationsAfter: number
  }
  tile?: TileSeamSummary
  animation?: {
    sharedGridId: string
    sharedPaletteId: string
    keyFrameScore: number
  }
}

function validateAlignedGrid(
  width: number,
  height: number,
  arrays: readonly { length: number }[],
  label: string,
): void {
  if (Number.isInteger(width) === false || width <= 0
    || Number.isInteger(height) === false || height <= 0) {
    throw new RangeError(`${label} dimensions must be positive integers`)
  }
  const cells = width * height
  if (arrays.some((array) => array.length !== cells)) {
    throw new RangeError(`${label} arrays must align with the grid`)
  }
}

function sceneLayer(label: string | undefined): SceneLayerId {
  const normalized = label?.trim().toLowerCase() ?? ''
  if (/background|backdrop|sky|distant|horizon|背景|天空|远景/.test(normalized)) {
    return 'background'
  }
  if (/foreground|subject|person|portrait|pet|face|body|前景|主体|人物|宠物/.test(normalized)) {
    return 'foreground'
  }
  if (/middle|water|ground|terrain|vegetation|building|rock|tree|road|中景|水面|地面|植被|建筑|岩石/.test(normalized)) {
    return 'middle'
  }
  return 'foreground'
}

export function applyArtDirectionImportance(
  input: ArtDirectionImportanceInput,
): ArtDirectionImportanceResult {
  validateAlignedGrid(input.width, input.height, [
    input.activeMask,
    input.baseImportance,
    input.semanticLabelsByCell,
  ], 'Art direction importance')
  const layerFactors = new Map(input.plan.scene.layers.map((layer) => [
    layer.id,
    0.5 + layer.detailFactor * 0.5,
  ]))
  const importance = [...input.baseImportance]
  const layerCells: Record<SceneLayerId, number> = { background: 0, middle: 0, foreground: 0 }
  let changedCells = 0
  let backgroundCompressedCells = 0
  let focusEnhancedCells = 0
  let maximumFocusBoost = 0
  const radius = 0.42
  for (let cell = 0; cell < importance.length; cell += 1) {
    if (input.activeMask[cell] !== 1) continue
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    const layer = sceneLayer(input.semanticLabelsByCell[cell])
    layerCells[layer] += 1
    const base = input.baseImportance[cell] ?? 0
    const normalizedX = (x + 0.5) / input.width
    const normalizedY = (y + 0.5) / input.height
    const distance = Math.hypot(
      normalizedX - input.plan.focus[0],
      normalizedY - input.plan.focus[1],
    )
    const focusBoost = clamp(1 - distance / radius) * 0.9
      * (layer === 'background' ? 0.2 : layer === 'middle' ? 0.55 : 1)
    const layerFactor = layerFactors.get(layer) ?? 1
    const planned = base >= 2.5
      ? Math.max(base, base * layerFactor + focusBoost)
      : clamp(base * layerFactor + focusBoost, 0, 4)
    importance[cell] = planned
    if (Math.abs(planned - base) > 1e-9) changedCells += 1
    if (layer === 'background' && planned < base - 1e-9) backgroundCompressedCells += 1
    if (planned > base + 1e-9 && focusBoost > 0) focusEnhancedCells += 1
    maximumFocusBoost = Math.max(maximumFocusBoost, focusBoost)
  }
  return {
    importance,
    summary: {
      changedCells,
      backgroundCompressedCells,
      focusEnhancedCells,
      maximumFocusBoost,
      layerCells,
    },
  }
}

function tileEdgePairs(input: TileSeamInput): readonly (readonly [number, number])[] {
  const pairs: Array<readonly [number, number]> = []
  const edge = (value: string) => value.trim().toLowerCase()
  if (edge(input.tileEdges.top) === edge(input.tileEdges.bottom)) {
    for (let x = 0; x < input.width; x += 1) {
      pairs.push([x, (input.height - 1) * input.width + x])
    }
  }
  if (edge(input.tileEdges.left) === edge(input.tileEdges.right)) {
    for (let y = 0; y < input.height; y += 1) {
      pairs.push([y * input.width, y * input.width + input.width - 1])
    }
  }
  return pairs
}

function seamMismatchCount(
  input: TileSeamInput,
  colorIds: readonly string[],
  pairs: readonly (readonly [number, number])[],
): number {
  return pairs.reduce((count, [first, second]) => count + Number(
    input.activeMask[first] === 1
      && input.activeMask[second] === 1
      && colorIds[first] !== colorIds[second],
  ), 0)
}

export function enforceTileSeams(input: TileSeamInput): TileSeamResult {
  validateAlignedGrid(input.width, input.height, [input.colorIds, input.activeMask], 'Tile seam')
  const pairs = tileEdgePairs(input)
  const original = [...input.colorIds]
  const colorIds = [...input.colorIds]
  const mismatchesBefore = seamMismatchCount(input, original, pairs)
  let protectedConflicts = 0
  for (const [first, second] of pairs) {
    if (first === second || input.activeMask[first] !== 1 || input.activeMask[second] !== 1
      || colorIds[first] === colorIds[second]) continue
    const firstProtected = input.protectedCells.has(first)
    const secondProtected = input.protectedCells.has(second)
    if (firstProtected && secondProtected) {
      protectedConflicts += 1
      continue
    }
    if (secondProtected) colorIds[first] = colorIds[second]!
    else colorIds[second] = colorIds[first]!
  }
  const edits: GridEditRecord[] = colorIds.flatMap((colorId, cell) => {
    if (colorId === original[cell]) return []
    return [{
      x: cell % input.width,
      y: Math.floor(cell / input.width),
      fromColorId: original[cell]!,
      toColorId: colorId,
      reason: 'tile-seam' as const,
    }]
  })
  return {
    colorIds,
    edits,
    summary: {
      constrainedPairs: pairs.length,
      mismatchesBefore,
      mismatchesAfter: seamMismatchCount(input, colorIds, pairs),
      seamEdits: edits.length,
      protectedConflicts,
    },
  }
}

function validateFrameScore(value: number, label: string): void {
  if (Number.isFinite(value) === false || value < 0 || value > 1) {
    throw new RangeError(`Animation ${label} must stay within 0..1`)
  }
}

export function selectAnimationKeyFrame(
  frames: readonly AnimationFrameCandidate[],
): AnimationKeyFrameSelection {
  if (frames.length === 0) throw new RangeError('Animation key-frame selection requires candidates')
  const ids = new Set<string>()
  const sharedGridId = frames[0]!.sharedGridId.trim()
  const sharedPaletteId = frames[0]!.sharedPaletteId.trim()
  if (sharedGridId.length === 0 || sharedPaletteId.length === 0) {
    throw new RangeError('Animation candidates require shared grid and palette identities')
  }
  const scores: Record<string, number> = {}
  for (const frame of frames) {
    const id = frame.id.trim()
    if (id.length === 0 || ids.has(id)) throw new RangeError('Animation candidate ids must be unique and non-empty')
    ids.add(id)
    if (frame.sharedGridId.trim() !== sharedGridId || frame.sharedPaletteId.trim() !== sharedPaletteId) {
      throw new RangeError('Animation candidates must share grid and palette identities')
    }
    for (const [label, value] of [
      ['silhouette', frame.silhouette],
      ['feature visibility', frame.featureVisibility],
      ['action arc', frame.actionArc],
      ['blur', frame.blur],
      ['occlusion', frame.occlusion],
    ] as const) validateFrameScore(value, label)
    scores[id] = clamp(
      frame.silhouette * 0.32
        + frame.featureVisibility * 0.28
        + frame.actionArc * 0.25
        + (1 - frame.blur) * 0.08
        + (1 - frame.occlusion) * 0.07,
    )
  }
  const rankedFrameIds = [...ids].sort((first, second) =>
    scores[second]! - scores[first]! || first.localeCompare(second))
  return {
    selectedFrameId: rankedFrameIds[0]!,
    rankedFrameIds,
    scores,
    sharedGridId,
    sharedPaletteId,
  }
}

export function planPixelArtDirection(input: PixelArtDirectionInput): PixelArtDirectionPlan {
  if (Number.isInteger(input.width) === false || input.width <= 0
    || Number.isInteger(input.height) === false || input.height <= 0) {
    throw new RangeError('Pixel art direction dimensions must be positive integers')
  }
  const occupancy = clamp(input.subjectOccupancy)
  const profile = styleProfiles[input.style]
  if (profile === undefined) throw new RangeError('Pixel art direction style is unsupported')
  const cells = input.width * input.height
  const scale = Math.sqrt(cells) / 32
  const identityRatio = input.imageType === 'portrait' || input.imageType === 'pet' ? 0.085 : 0.045
  const silhouetteRatio = 0.12 + (1 - occupancy) * 0.04
  const transitionRatio = 0.04 * profile.transitionFactor
  const textureRatio = clamp((scale - 0.45) * 0.045 * profile.clusterScale, 0.01, 0.11)
  const negativeSpaceRatio = clamp(1 - occupancy, 0.04, 0.72)
  const labels = new Set((input.semanticLabels ?? []).map((label) => label.trim().toLowerCase()))
  const depth = input.depthRange ?? [0, input.imageType === 'landscape' ? 1 : 0.55]
  const depthSpan = clamp(Math.abs(depth[1] - depth[0]))
  const estimatedBeads = Math.round(cells * occupancy)
  const diameter = input.beadDiameterMm ?? 5
  const thinRisk = clamp((input.width <= 32 ? 0.34 : input.width <= 48 ? 0.2 : 0.12)
    + (labels.has('weapon') || labels.has('branch') || labels.has('tail') ? 0.2 : 0))
  const transitionBudget = Math.max(1, Math.round(cells * transitionRatio))
  const tile = tilePlan(input)
  const animation = animationPlan(input)
  return {
    profile: {
      id: profile.id,
      clusterScale: profile.clusterScale,
      edgeRhythm: profile.edgeRhythm,
      saturationCurve: profile.saturationCurve,
      hueShiftStrength: profile.hueShiftStrength,
    },
    focus: unitPoint(input.focus, input.imageType === 'portrait' ? [0.5, 0.38] : [0.5, 0.5]),
    lightDirection: direction(input.lightDirection),
    detailBudget: {
      identityCells: Math.max(1, Math.round(cells * identityRatio * Math.min(1.6, scale))),
      silhouetteCells: Math.max(4, Math.round(cells * silhouetteRatio)),
      textureCells: Math.max(1, Math.round(cells * textureRatio)),
      transitionCells: transitionBudget,
      negativeSpaceCells: Math.round(cells * negativeSpaceRatio),
    },
    transitionBudget,
    dither: {
      patternDensity: clamp(profile.ditherDensity * Math.min(1.5, scale)),
      maximumColorSwitches: Math.max(2, Math.round(Math.sqrt(cells) * (0.8 + profile.ditherDensity * 3))),
      localNoiseBudget: Math.max(0, Math.round(cells * profile.ditherDensity * 0.12)),
    },
    outline: {
      mode: 'selective',
      lightOpacity: profile.outlineLight,
      shadowOpacity: profile.outlineShadow,
      maximumWidthCells: input.width <= 32 ? 1 : 2,
      openEdgeRatio: clamp(0.12 + profile.outlineLight * 0.5),
    },
    scene: {
      layers: [
        { id: 'background', detailFactor: 0.35, valueSeparation: 0.2 },
        { id: 'middle', detailFactor: 0.65, valueSeparation: 0.14 },
        { id: 'foreground', detailFactor: 1, valueSeparation: 0.1 },
      ],
      occlusionBudget: Math.round(cells * depthSpan * 0.04),
      perspectiveStrength: input.imageType === 'landscape' ? clamp(0.45 + depthSpan * 0.45) : clamp(depthSpan * 0.4),
      depthOfFieldStrength: clamp(depthSpan * (input.style === 'faithful' ? 0.4 : 0.22)),
    },
    materials: materialProfiles(labels),
    ...(tile === undefined ? {} : { tile }),
    ...(animation === undefined ? {} : { animation }),
    craft: {
      estimatedBeads,
      boardWidthMm: input.width * diameter,
      boardHeightMm: input.height * diameter,
      fragilityPenalty: thinRisk,
      sectionCount: Math.max(1, Math.ceil(estimatedBeads / 1_024)),
    },
    generation: {
      valueLevels: profile.valueLevels,
      maxColorFactor: profile.colorFactor,
      isolatedPixelPenalty: 1.1 + profile.clusterScale * 0.65,
      stripePenalty: 0.9 + thinRisk * 0.75,
      aliasPenalty: 0.8 + profile.edgeRhythm * 0.65,
      paletteCoherence: 0.9 + profile.clusterScale * 0.3,
      edgeProtection: clamp(0.62 + profile.edgeRhythm * 0.26),
    },
  }
}
