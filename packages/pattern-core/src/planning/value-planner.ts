import {
  validateStructurePlan,
  validateValuePlan,
  type StructurePlan,
  type ValuePlan,
  type ValueRole,
  type ValueRoleKind,
} from '../contracts.js'
import type { Lab, OutlineMode } from '../types.js'
import {
  planContrastAwareOutline,
  type OutlinePlanningDiagnostics,
} from './outline-planner.js'

export interface SemanticValueGaps {
  eyeSkin: number
  faceHair: number
  subjectBackground: number
}

export interface ValueLighting {
  /** Unit-free direction toward the lit side of the image. */
  direction: readonly [x: number, y: number]
  intensity: number
  ambientLight: number
}

export type MaterialValueKind =
  | 'generic'
  | 'skin'
  | 'hair'
  | 'metal'
  | 'wood'
  | 'stone'
  | 'soil'
  | 'water'
  | 'glass'
  | 'fabric'

export interface ValuePlanningInput {
  structurePlan: StructurePlan
  pixelLabs: readonly Lab[]
  activeMask: Uint8Array
  levels: 2 | 3 | 4
  outlineMode?: OutlineMode
  minimumSemanticGaps?: Partial<SemanticValueGaps>
  lighting?: ValueLighting
  materialByRegionId?: Readonly<Record<string, MaterialValueKind>>
}

export interface ValueGroupDiagnostic {
  groupId: string
  sourceRegionId: string
  semanticClass: string
  sourceMeanLightness: number
}

export interface SemanticGapDiagnostic {
  kind: keyof SemanticValueGaps
  firstGroupId: string
  secondGroupId: string
  required: number
  actual: number
}

export interface ValuePlanningDiagnostics {
  roleOrderAccuracy: number
  semanticGapAccuracy: number
  minimumSemanticGap: number
  maximumLightingAdjustment: number
  maximumMaterialAdjustment: number
  outline: OutlinePlanningDiagnostics
  groups: readonly ValueGroupDiagnostic[]
  semanticGaps: readonly SemanticGapDiagnostic[]
}

export interface ValuePlanningResult {
  plan: ValuePlan
  roleIdsByCell: readonly (string | undefined)[]
  plannedLabs: readonly Lab[]
  diagnostics: ValuePlanningDiagnostics
}

interface RoleDefinition {
  kind: ValueRoleKind
  quantile: number
  importanceScale: number
}

type SemanticClass = 'eye' | 'skin' | 'hair' | 'background' | 'subject' | 'other'

interface ValueGroup {
  id: string
  sourceRegionId: string
  semanticClass: SemanticClass
  cells: readonly number[]
  importance: number
  sourceMeanLightness: number
  centroid: readonly [number, number]
}

interface PlannedValueGroup extends ValueGroup {
  roles: ValueRole[]
}

const roleDefinitions: Readonly<Record<2 | 3 | 4, readonly RoleDefinition[]>> = {
  2: [
    { kind: 'shadow', quantile: 0.25, importanceScale: 0.9 },
    { kind: 'base', quantile: 0.7, importanceScale: 1 },
  ],
  3: [
    { kind: 'shadow', quantile: 0.2, importanceScale: 0.9 },
    { kind: 'base', quantile: 0.5, importanceScale: 1 },
    { kind: 'light', quantile: 0.8, importanceScale: 0.82 },
  ],
  4: [
    { kind: 'outline', quantile: 0.04, importanceScale: 0.95 },
    { kind: 'deep-shadow', quantile: 0.18, importanceScale: 0.93 },
    { kind: 'shadow', quantile: 0.38, importanceScale: 0.9 },
    { kind: 'base', quantile: 0.65, importanceScale: 1 },
    { kind: 'light', quantile: 0.92, importanceScale: 0.82 },
  ],
}

const outlineRoleDefinition: RoleDefinition = {
  kind: 'outline',
  quantile: 0.04,
  importanceScale: 0.95,
}

function resolvedRoleDefinitions(
  levels: 2 | 3 | 4,
  outlineMode: OutlineMode,
): readonly RoleDefinition[] {
  const tonal = roleDefinitions[levels].filter((definition) => definition.kind !== 'outline')
  return outlineMode === 'off' ? tonal : [outlineRoleDefinition, ...tonal]
}

const defaultSemanticGaps: SemanticValueGaps = {
  eyeSkin: 16,
  faceHair: 10,
  subjectBackground: 12,
}

const materialRoleAdjustment: Readonly<Record<MaterialValueKind, Partial<Record<ValueRoleKind, number>>>> = {
  generic: {},
  skin: { shadow: 0.8, light: 1.2 },
  hair: { 'deep-shadow': -1.2, shadow: -0.8, light: 1.6 },
  metal: { outline: -1.5, 'deep-shadow': -2.2, shadow: -1, base: 0.8, light: 4.5, highlight: 5 },
  wood: { 'deep-shadow': -0.8, shadow: -0.5, light: 1.2 },
  stone: { shadow: -0.4, light: 0.8 },
  soil: { shadow: -0.6, light: 0.6 },
  water: { shadow: -1, base: 0.5, light: 3.2, highlight: 4.2 },
  glass: { outline: -1, shadow: -1.5, light: 4, highlight: 5 },
  fabric: { shadow: 0.4, light: 0.7 },
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 50
  const position = clamp((sorted.length - 1) * fraction, 0, sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const blend = position - lower
  return sorted[lower]! * (1 - blend) + sorted[upper]! * blend
}

function separatedTargets(rawTargets: readonly number[], minimumSeparation: number): readonly number[] {
  const targets = rawTargets.map((value) => clamp(value, 0, 100))
  for (let index = 1; index < targets.length; index += 1) {
    targets[index] = Math.max(targets[index]!, targets[index - 1]! + minimumSeparation)
  }
  const overflow = Math.max(0, targets[targets.length - 1]! - 100)
  if (overflow > 0) {
    for (let index = 0; index < targets.length; index += 1) targets[index] = targets[index]! - overflow
  }
  for (let index = targets.length - 2; index >= 0; index -= 1) {
    targets[index] = Math.min(targets[index]!, targets[index + 1]! - minimumSeparation)
  }
  return targets.map((value) => clamp(value, 0, 100))
}

function classifySemantic(text: string): SemanticClass {
  const normalized = text.toLowerCase()
  if (/eye|iris|pupil|眼/.test(normalized)) return 'eye'
  if (/hair|fur|mane|发|毛/.test(normalized)) return 'hair'
  if (/skin|face|head|脸|面|皮肤/.test(normalized)) return 'skin'
  if (/background|backdrop|sky|背景|天空/.test(normalized)) return 'background'
  if (/subject|body|person|human|pet|animal|object|主体|身体|人物|宠物|物件/.test(normalized)) return 'subject'
  return 'other'
}

function roleTarget(group: PlannedValueGroup, kind: ValueRoleKind): number | undefined {
  return group.roles.find((role) => role.kind === kind)?.targetLightness
}

function shiftGroup(group: PlannedValueGroup, requestedDelta: number): number {
  const minimum = Math.min(...group.roles.map((role) => role.targetLightness))
  const maximum = Math.max(...group.roles.map((role) => role.targetLightness))
  const delta = clamp(requestedDelta, -minimum, 100 - maximum)
  for (const role of group.roles) role.targetLightness += delta
  return delta
}

function lightAdjustment(
  group: ValueGroup,
  role: ValueRoleKind,
  lighting: ValueLighting | undefined,
  width: number,
  height: number,
): number {
  if (lighting === undefined) return 0
  const magnitude = Math.hypot(lighting.direction[0], lighting.direction[1])
  const directionX = magnitude === 0 ? 0 : lighting.direction[0] / magnitude
  const directionY = magnitude === 0 ? 0 : lighting.direction[1] / magnitude
  const relativeX = width <= 1 ? 0 : group.centroid[0] / (width - 1) * 2 - 1
  const relativeY = height <= 1 ? 0 : group.centroid[1] / (height - 1) * 2 - 1
  const roleFactor: Readonly<Partial<Record<ValueRoleKind, number>>> = {
    outline: 0.35,
    'deep-shadow': 0.5,
    shadow: 0.7,
    base: 0.85,
    light: 1,
    highlight: 1,
  }
  const ambientFactor: Readonly<Partial<Record<ValueRoleKind, number>>> = {
    outline: 2,
    'deep-shadow': 2.8,
    shadow: 3,
    base: 1.2,
    light: 0.3,
    highlight: 0,
  }
  const directional = (relativeX * directionX + relativeY * directionY)
    * 3 * lighting.intensity * (roleFactor[role] ?? 0)
  const ambient = lighting.ambientLight * (ambientFactor[role] ?? 0)
  return clamp(directional + ambient, -4, 4)
}

function enforceLower(lower: PlannedValueGroup, upper: PlannedValueGroup, gap: number): void {
  const lowerBase = roleTarget(lower, 'base') ?? 50
  const upperBase = roleTarget(upper, 'base') ?? 50
  const deficit = gap - (upperBase - lowerBase)
  if (deficit <= 0) return
  const lowerShift = shiftGroup(lower, -deficit)
  const remaining = deficit + lowerShift
  if (remaining > 0) shiftGroup(upper, remaining)
}

function enforceSemanticGaps(
  groups: readonly PlannedValueGroup[],
  gaps: SemanticValueGaps,
): readonly SemanticGapDiagnostic[] {
  const diagnostics: SemanticGapDiagnostic[] = []
  const eyes = groups.filter((group) => group.semanticClass === 'eye')
  const skins = groups.filter((group) => group.semanticClass === 'skin')
  const hairs = groups.filter((group) => group.semanticClass === 'hair')
  const subjects = groups.filter((group) => group.semanticClass === 'subject'
    || group.semanticClass === 'skin')
  const backgrounds = groups.filter((group) => group.semanticClass === 'background')

  for (const eye of eyes) for (const skin of skins) {
    enforceLower(eye, skin, gaps.eyeSkin)
    diagnostics.push({
      kind: 'eyeSkin',
      firstGroupId: eye.id,
      secondGroupId: skin.id,
      required: gaps.eyeSkin,
      actual: Math.max(0, (roleTarget(skin, 'base') ?? 0) - (roleTarget(eye, 'base') ?? 0)),
    })
  }
  for (const hair of hairs) for (const face of skins) {
    if (hair.sourceMeanLightness <= face.sourceMeanLightness) enforceLower(hair, face, gaps.faceHair)
    else enforceLower(face, hair, gaps.faceHair)
    diagnostics.push({
      kind: 'faceHair',
      firstGroupId: face.id,
      secondGroupId: hair.id,
      required: gaps.faceHair,
      actual: Math.abs((roleTarget(face, 'base') ?? 0) - (roleTarget(hair, 'base') ?? 0)),
    })
  }
  for (const subject of subjects) for (const background of backgrounds) {
    if (subject.sourceMeanLightness < background.sourceMeanLightness) {
      enforceLower(subject, background, gaps.subjectBackground)
    } else {
      enforceLower(background, subject, gaps.subjectBackground)
    }
    diagnostics.push({
      kind: 'subjectBackground',
      firstGroupId: subject.id,
      secondGroupId: background.id,
      required: gaps.subjectBackground,
      actual: Math.abs((roleTarget(subject, 'base') ?? 0) - (roleTarget(background, 'base') ?? 0)),
    })
  }
  return diagnostics
}

function validateInput(input: ValuePlanningInput): void {
  validateStructurePlan(input.structurePlan)
  const cells = input.structurePlan.width * input.structurePlan.height
  if (input.pixelLabs.length !== cells || input.activeMask.length !== cells) {
    throw new RangeError('Value planning arrays must align with the StructurePlan grid')
  }
  for (const lab of input.pixelLabs) {
    if (lab.some((value) => Number.isFinite(value) === false)) {
      throw new RangeError('Value planning Lab values must be finite')
    }
  }
  for (const value of input.activeMask) {
    if (value !== 0 && value !== 1) throw new RangeError('Value planning mask must be binary')
  }
  for (const gap of Object.values(input.minimumSemanticGaps ?? {})) {
    if (Number.isFinite(gap) === false || gap! < 0 || gap! > 100) {
      throw new RangeError('Semantic value gaps must be finite values in the range 0..100')
    }
  }
  if (input.lighting !== undefined) {
    if (input.lighting.direction.some((value) => Number.isFinite(value) === false)
      || Number.isFinite(input.lighting.intensity) === false
      || Number.isFinite(input.lighting.ambientLight) === false
      || input.lighting.intensity < 0 || input.lighting.intensity > 1
      || input.lighting.ambientLight < 0 || input.lighting.ambientLight > 1) {
      throw new RangeError('Value lighting inputs must be finite and strengths must be in the range 0..1')
    }
  }
}

function valueGroups(input: ValuePlanningInput): readonly ValueGroup[] {
  const grouped = new Map<string, {
    cells: number[]
    weightedImportance: number
    sourceRegionId: string
    label: string
  }>()
  for (const region of input.structurePlan.regions) {
    const cells = region.cellIndices.filter((cell) => input.activeMask[cell] === 1)
    if (cells.length === 0) continue
    const meanA = cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![1], 0) / cells.length
    const meanB = cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![2], 0) / cells.length
    const chromaFamily = `${Math.floor((meanA + 128) / 32)}:${Math.floor((meanB + 128) / 32)}`
    const sourceRegionId = region.sourceRegionId ?? region.label ?? `region-${region.id}`
    const key = `${sourceRegionId}|${chromaFamily}`
    const current = grouped.get(key) ?? {
      cells: [],
      weightedImportance: 0,
      sourceRegionId,
      label: region.label ?? sourceRegionId,
    }
    current.cells.push(...cells)
    current.weightedImportance += region.importance * cells.length
    grouped.set(key, current)
  }
  return [...grouped.entries()]
    .sort((first, second) => first[0].localeCompare(second[0]))
    .map(([key, group], index) => ({
      id: `group-${index}:${key}`,
      sourceRegionId: group.sourceRegionId,
      semanticClass: classifySemantic(`${group.sourceRegionId} ${group.label}`),
      cells: [...group.cells].sort((first, second) => first - second),
      importance: clamp(group.weightedImportance / Math.max(1, group.cells.length), 0, 1),
      sourceMeanLightness: group.cells.reduce((sum, cell) =>
        sum + input.pixelLabs[cell]![0], 0) / Math.max(1, group.cells.length),
      centroid: [
        group.cells.reduce((sum, cell) => sum + cell % input.structurePlan.width, 0)
          / Math.max(1, group.cells.length),
        group.cells.reduce((sum, cell) => sum + Math.floor(cell / input.structurePlan.width), 0)
          / Math.max(1, group.cells.length),
      ] as const,
    }))
}

function buildOutlineImportance(
  input: ValuePlanningInput,
  groups: readonly PlannedValueGroup[],
): Float32Array {
  const importance = new Float32Array(input.activeMask.length)
  for (const group of groups) {
    const regionalImportance = Math.min(0.8, group.importance * 0.8)
    for (const cell of group.cells) importance[cell] = Math.max(importance[cell]!, regionalImportance)
  }
  for (const constraint of input.structurePlan.featureConstraints) {
    const radius = Math.max(
      0,
      Math.ceil(Math.sqrt(Math.max(1, constraint.maximumCells)) / 2 + constraint.allowedShiftCells),
    )
    const minimumX = Math.max(0, Math.floor(constraint.targetCenter[0] - radius))
    const maximumX = Math.min(input.structurePlan.width - 1, Math.ceil(constraint.targetCenter[0] + radius))
    const minimumY = Math.max(0, Math.floor(constraint.targetCenter[1] - radius))
    const maximumY = Math.min(input.structurePlan.height - 1, Math.ceil(constraint.targetCenter[1] + radius))
    const featureImportance = constraint.hard ? 1 : 0.9
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const cell = y * input.structurePlan.width + x
        if (input.activeMask[cell] !== 1) continue
        importance[cell] = Math.max(importance[cell]!, featureImportance)
      }
    }
  }
  return importance
}

function semanticOutlineRegionIds(structurePlan: StructurePlan): Int32Array {
  const semanticIds = new Int32Array(structurePlan.regionIds.length).fill(-1)
  const idBySourceRegion = new Map<string, number>()
  for (const region of [...structurePlan.regions].sort((first, second) => first.id - second.id)) {
    const sourceRegionId = region.sourceRegionId ?? region.label ?? `structure-region-${region.id}`
    let semanticId = idBySourceRegion.get(sourceRegionId)
    if (semanticId === undefined) {
      semanticId = idBySourceRegion.size
      idBySourceRegion.set(sourceRegionId, semanticId)
    }
    for (const cell of region.cellIndices) semanticIds[cell] = semanticId
  }
  return semanticIds
}

export function buildValuePlan(input: ValuePlanningInput): ValuePlanningResult {
  validateInput(input)
  const roleIdsByCell: Array<string | undefined> = new Array(input.activeMask.length)
  const plannedLabs = input.pixelLabs.map((lab) => [...lab] as Lab)
  const outlineMode = input.outlineMode ?? (input.levels === 4 ? 'selective' : 'off')
  const definitions = resolvedRoleDefinitions(input.levels, outlineMode)
  let maximumLightingAdjustment = 0
  let maximumMaterialAdjustment = 0
  const groups: PlannedValueGroup[] = valueGroups(input).map((group) => {
    const lightness = group.cells.map((cell) => input.pixelLabs[cell]![0])
      .sort((first, second) => first - second)
    const minimumSeparation = input.levels === 2 ? 8 : 6
    const rawTargets = separatedTargets(
      definitions.map((definition) => quantile(lightness, definition.quantile)),
      minimumSeparation,
    )
    const material = input.materialByRegionId?.[group.sourceRegionId] ?? 'generic'
    const adjustedTargets = definitions.map((definition, index) => {
      const lightingAdjustment = lightAdjustment(
        group,
        definition.kind,
        input.lighting,
        input.structurePlan.width,
        input.structurePlan.height,
      )
      const materialAdjustment = clamp(materialRoleAdjustment[material]?.[definition.kind] ?? 0, -5, 5)
      maximumLightingAdjustment = Math.max(maximumLightingAdjustment, Math.abs(lightingAdjustment))
      maximumMaterialAdjustment = Math.max(maximumMaterialAdjustment, Math.abs(materialAdjustment))
      return rawTargets[index]! + lightingAdjustment + materialAdjustment
    })
    const targets = separatedTargets(adjustedTargets, minimumSeparation)
    const roles = definitions.map((definition, index): ValueRole => ({
      id: `${group.id}:${definition.kind}`,
      regionId: group.id,
      kind: definition.kind,
      targetLightness: targets[index]!,
      minimumSeparation,
      importance: clamp(group.importance * definition.importanceScale, 0, 1),
    }))
    return { ...group, roles }
  })
  const semanticGaps = enforceSemanticGaps(groups, {
    ...defaultSemanticGaps,
    ...input.minimumSemanticGaps,
  })
  const roles = groups.flatMap((group) => group.roles)
  const outlineImportance = buildOutlineImportance(input, groups)
  const outlinePlanning = planContrastAwareOutline({
    width: input.structurePlan.width,
    height: input.structurePlan.height,
    activeMask: input.activeMask,
    boundaryStrength: input.structurePlan.boundaryStrength,
    regionIds: semanticOutlineRegionIds(input.structurePlan),
    pixelLabs: input.pixelLabs,
    importance: outlineImportance,
    mode: outlineMode,
    ...(input.lighting === undefined ? {} : { lightDirection: input.lighting.direction }),
  })
  for (const group of groups) {
    const meanA = group.cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![1], 0) / group.cells.length
    const meanB = group.cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![2], 0) / group.cells.length
    for (const cell of group.cells) {
      const sourceLightness = input.pixelLabs[cell]![0]
      const tonalRoles = group.roles.filter((candidate) => candidate.kind !== 'outline')
      let role = tonalRoles.reduce((best, candidate) =>
        Math.abs(candidate.targetLightness - sourceLightness)
          < Math.abs(best.targetLightness - sourceLightness)
          ? candidate
          : best)
      const outline = group.roles.find((candidate) => candidate.kind === 'outline')
      if (outline !== undefined && outlinePlanning.mask[cell] === 1) {
        role = outline
      }
      roleIdsByCell[cell] = role.id
      plannedLabs[cell] = [role.targetLightness, meanA, meanB]
    }
  }
  const plan = { roles: roles.sort((first, second) => first.id.localeCompare(second.id)) }
  validateValuePlan(plan)
  let orderedPairs = 0
  let validOrderedPairs = 0
  for (const group of groups) {
    const ordered = [...group.roles].sort((first, second) =>
      first.targetLightness - second.targetLightness)
    for (let index = 1; index < ordered.length; index += 1) {
      orderedPairs += 1
      if (ordered[index]!.targetLightness - ordered[index - 1]!.targetLightness
        >= ordered[index]!.minimumSeparation) validOrderedPairs += 1
    }
  }
  const satisfiedSemanticGaps = semanticGaps.filter((gap) => gap.actual + 1e-9 >= gap.required).length
  const diagnostics: ValuePlanningDiagnostics = {
    roleOrderAccuracy: orderedPairs === 0 ? 1 : validOrderedPairs / orderedPairs,
    semanticGapAccuracy: semanticGaps.length === 0 ? 1 : satisfiedSemanticGaps / semanticGaps.length,
    minimumSemanticGap: semanticGaps.length === 0
      ? 100
      : Math.min(...semanticGaps.map((gap) => gap.actual)),
    maximumLightingAdjustment,
    maximumMaterialAdjustment,
    outline: outlinePlanning.diagnostics,
    groups: groups.map((group) => ({
      groupId: group.id,
      sourceRegionId: group.sourceRegionId,
      semanticClass: group.semanticClass,
      sourceMeanLightness: group.sourceMeanLightness,
    })),
    semanticGaps,
  }
  return { plan, roleIdsByCell, plannedLabs, diagnostics }
}
