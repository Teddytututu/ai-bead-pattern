import { colorDistance, prepareColors, type PreparedColor } from '../color.js'
import {
  validatePalettePlan,
  validateStructurePlan,
  validateValuePlan,
  type ColorRole,
  type PalettePlan,
  type StructurePlan,
  type ValuePlan,
  type ValueRole,
} from '../contracts.js'
import type { ColorDistanceMethod, Lab, MaterialColor } from '../types.js'
import type { ResolvedFeaturePlacement } from './feature-placement.js'

export interface PalettePlanningInput {
  valuePlan: ValuePlan
  roleIdsByCell: readonly (string | undefined)[]
  plannedLabs: readonly Lab[]
  structurePlan: StructurePlan
  colors: readonly MaterialColor[]
  maximumColors: number
  distanceMethod: ColorDistanceMethod
  featurePlacements: readonly ResolvedFeaturePlacement[]
  /** Missing entries represent unrestricted stock; supplied entries are bead counts. */
  inventory?: Readonly<Record<string, number>>
  /** Ordered physical substitutes for an unavailable or insufficient preferred color. */
  substituteColorIds?: Readonly<Record<string, readonly string[]>>
}

export interface PaletteSubstitutionDiagnostic {
  roleId: string
  preferredColorId: string
  selectedColorId: string
}

export interface PalettePlanningDiagnostics {
  roleOrderAccuracy: number
  relaxedRegionIds: readonly string[]
  substitutions: readonly PaletteSubstitutionDiagnostic[]
  inventoryUse: Readonly<Record<string, number>>
}

export interface PalettePlanningResult {
  plan: PalettePlan
  colorRoles: readonly ColorRole[]
  colorIds: readonly string[]
  diagnostics: PalettePlanningDiagnostics
}

interface PlannedRole {
  valueRole: ValueRole
  colorRole: ColorRole
  allowedColors: readonly PreparedColor[]
  preferredColorId: string
  demand: number
  weight: number
}

interface AssignmentResult {
  assignments: Readonly<Record<string, string>>
  relaxedRegionIds: readonly string[]
  inventoryUse: Readonly<Record<string, number>>
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function hueDegrees(lab: Lab): number {
  const degrees = Math.atan2(lab[2], lab[1]) * 180 / Math.PI
  return degrees < 0 ? degrees + 360 : degrees
}

function hueDifference(first: Lab, second: Lab): number {
  const difference = Math.abs(hueDegrees(first) - hueDegrees(second))
  return Math.min(difference, 360 - difference)
}

function roleCost(role: ColorRole, color: PreparedColor, method: ColorDistanceMethod): number {
  return colorDistance(role.idealLab, color.lab, method)
    + Math.abs(role.idealLab[0] - color.lab[0]) * 0.08
}

function stock(input: PalettePlanningInput, colorId: string): number {
  return input.inventory?.[colorId] ?? Number.POSITIVE_INFINITY
}

function validateInput(input: PalettePlanningInput): void {
  validateValuePlan(input.valuePlan)
  validateStructurePlan(input.structurePlan)
  const cells = input.structurePlan.width * input.structurePlan.height
  if (input.roleIdsByCell.length !== cells || input.plannedLabs.length !== cells) {
    throw new RangeError('Palette planning arrays must align with the StructurePlan grid')
  }
  if (input.colors.length === 0 || Number.isInteger(input.maximumColors) === false
    || input.maximumColors <= 0 || input.maximumColors > input.colors.length) {
    throw new RangeError('Palette planning requires a positive color limit within the material palette')
  }
  for (const lab of input.plannedLabs) {
    if (lab.some((value) => Number.isFinite(value) === false)) {
      throw new RangeError('Palette planning Lab values must be finite')
    }
  }
  const colorIds = new Set(input.colors.map((color) => color.id))
  for (const [colorId, quantity] of Object.entries(input.inventory ?? {})) {
    if (colorIds.has(colorId) === false || Number.isInteger(quantity) === false || quantity < 0) {
      throw new RangeError('Palette inventory must reference known colors with non-negative integer counts')
    }
  }
  for (const [colorId, substitutes] of Object.entries(input.substituteColorIds ?? {})) {
    if (colorIds.has(colorId) === false || substitutes.some((id) => colorIds.has(id) === false)
      || new Set(substitutes).size !== substitutes.length) {
      throw new RangeError('Palette substitutions must reference unique known color ids')
    }
  }
  const required = input.roleIdsByCell.filter((roleId) => roleId !== undefined).length
  const finiteCapacity = input.colors.reduce((sum, color) => sum + stock(input, color.id), 0)
  if (Number.isFinite(finiteCapacity) && finiteCapacity < required) {
    throw new RangeError('Palette inventory cannot cover all planned cells')
  }
}

function buildRoles(
  input: PalettePlanningInput,
  allColors: readonly PreparedColor[],
): readonly PlannedRole[] {
  const cellsByRole = new Map<string, number[]>()
  for (let cell = 0; cell < input.roleIdsByCell.length; cell += 1) {
    const roleId = input.roleIdsByCell[cell]
    if (roleId === undefined) continue
    const cells = cellsByRole.get(roleId) ?? []
    cells.push(cell)
    cellsByRole.set(roleId, cells)
  }
  return input.valuePlan.roles.map((valueRole) => {
    const cells = cellsByRole.get(valueRole.id) ?? []
    const idealLab: Lab = cells.length === 0
      ? [valueRole.targetLightness, 0, 0]
      : [
        valueRole.targetLightness,
        cells.reduce((sum, cell) => sum + input.plannedLabs[cell]![1], 0) / cells.length,
        cells.reduce((sum, cell) => sum + input.plannedLabs[cell]![2], 0) / cells.length,
      ]
    const colorRole: ColorRole = {
      id: `color:${valueRole.id}`,
      regionId: valueRole.regionId,
      valueRoleId: valueRole.id,
      idealLab,
      allowedHueShift: Math.hypot(idealLab[1], idealLab[2]) < 8 ? 180 : 48,
      mayShareColor: true,
      importance: valueRole.importance,
    }
    const preferred = [...allColors].sort((first, second) =>
      roleCost(colorRole, first, input.distanceMethod) - roleCost(colorRole, second, input.distanceMethod)
      || first.id.localeCompare(second.id))[0]!
    const hueCompatible = allColors.filter((color) =>
      stock(input, color.id) >= cells.length
      && (colorRole.allowedHueShift >= 180
        || Math.hypot(color.lab[1], color.lab[2]) < 6
        || hueDifference(colorRole.idealLab, color.lab) <= colorRole.allowedHueShift))
    const available = hueCompatible.length === 0
      ? allColors.filter((color) => stock(input, color.id) >= cells.length)
      : hueCompatible
    const substitutes = new Set(input.substituteColorIds?.[preferred.id] ?? [])
    const allowedColors = available
      .map((color) => ({
        color,
        substituteRank: substitutes.has(color.id) ? 0 : 1,
        cost: roleCost(colorRole, color, input.distanceMethod),
      }))
      .sort((first, second) => first.substituteRank - second.substituteRank
        || first.cost - second.cost || first.color.id.localeCompare(second.color.id))
      .slice(0, 12)
      .map((entry) => entry.color)
    return {
      valueRole,
      colorRole,
      allowedColors,
      preferredColorId: preferred.id,
      demand: cells.length,
      weight: Math.max(0.05, cells.length * Math.max(0.1, valueRole.importance)),
    }
  })
}

function assignmentCost(
  roles: readonly PlannedRole[],
  selected: ReadonlySet<string>,
  method: ColorDistanceMethod,
): number {
  if (selected.size === 0) return Number.POSITIVE_INFINITY
  return roles.reduce((total, role) => {
    const candidates = role.allowedColors.filter((color) => selected.has(color.id))
    if (candidates.length === 0) return total + 1_000_000 * role.weight
    const best = candidates.reduce((minimum, color) =>
      Math.min(minimum, roleCost(role.colorRole, color, method)), Number.POSITIVE_INFINITY)
    return total + best * role.weight
  }, 0)
}

function selectColors(
  input: PalettePlanningInput,
  colors: readonly PreparedColor[],
  roles: readonly PlannedRole[],
): readonly PreparedColor[] {
  const selectable = colors.filter((color) => stock(input, color.id) > 0)
  if (selectable.length === 0) throw new RangeError('Palette inventory has no available colors')
  const selected = new Set<string>()
  const featureRoles = new Set(input.featurePlacements.flatMap((placement) =>
    placement.roles.map((entry) => entry.role)))
  if ([...featureRoles].some((role) => role.endsWith('-dark'))) {
    selected.add([...selectable].sort((first, second) =>
      first.lab[0] - second.lab[0] || first.id.localeCompare(second.id))[0]!.id)
  }
  if (featureRoles.has('eye-highlight') && selected.size < input.maximumColors) {
    selected.add([...selectable].sort((first, second) =>
      second.lab[0] - first.lab[0] || first.id.localeCompare(second.id))[0]!.id)
  }
  while (selected.size < Math.min(input.maximumColors, selectable.length)) {
    let bestColor: PreparedColor | undefined
    let bestCost = Number.POSITIVE_INFINITY
    for (const color of selectable) {
      if (selected.has(color.id)) continue
      const trial = new Set(selected).add(color.id)
      const cost = assignmentCost(roles, trial, input.distanceMethod)
      if (cost < bestCost || (cost === bestCost && color.id.localeCompare(bestColor?.id ?? '') < 0)) {
        bestCost = cost
        bestColor = color
      }
    }
    if (bestColor === undefined) break
    selected.add(bestColor.id)
  }
  return colors.filter((color) => selected.has(color.id))
}

function solveRegion(
  roles: readonly PlannedRole[],
  selectedColors: readonly PreparedColor[],
  remaining: Readonly<Record<string, number>>,
  method: ColorDistanceMethod,
  minimumSeparationScale: 0 | 1,
  ordered: boolean,
): { assignments: readonly string[]; cost: number } | undefined {
  let best: { assignments: readonly string[]; cost: number } | undefined
  const visit = (
    index: number,
    previousLightness: number,
    capacities: Record<string, number>,
    assignments: string[],
    cost: number,
  ): void => {
    if (best !== undefined && cost > best.cost) return
    if (index === roles.length) {
      const candidate = { assignments: [...assignments], cost }
      if (best === undefined || candidate.cost < best.cost
        || (candidate.cost === best.cost
          && candidate.assignments.join('|').localeCompare(best.assignments.join('|')) < 0)) best = candidate
      return
    }
    const role = roles[index]!
    const allowed = new Set(role.allowedColors.map((color) => color.id))
    const compatible = selectedColors.filter((color) => allowed.has(color.id))
    const pool = compatible.length === 0 ? selectedColors : compatible
    const candidates = pool.filter((color) => capacities[color.id]! >= role.demand
      && (ordered === false
        || color.lab[0] >= previousLightness + role.valueRole.minimumSeparation * minimumSeparationScale))
      .sort((first, second) =>
        roleCost(role.colorRole, first, method) - roleCost(role.colorRole, second, method)
        || first.id.localeCompare(second.id))
    for (const color of candidates) {
      const next = { ...capacities, [color.id]: capacities[color.id]! - role.demand }
      visit(index + 1, color.lab[0], next, [...assignments, color.id],
        cost + roleCost(role.colorRole, color, method) * role.weight)
    }
  }
  visit(0, Number.NEGATIVE_INFINITY, { ...remaining }, [], 0)
  return best
}

function assignRoles(
  input: PalettePlanningInput,
  roles: readonly PlannedRole[],
  selectedColors: readonly PreparedColor[],
): AssignmentResult {
  const assignments: Record<string, string> = {}
  const inventoryUse: Record<string, number> = {}
  const remaining = Object.fromEntries(selectedColors.map((color) => [color.id, stock(input, color.id)]))
  const relaxedRegionIds: string[] = []
  const rolesByRegion = new Map<string, PlannedRole[]>()
  for (const role of roles) {
    const entries = rolesByRegion.get(role.valueRole.regionId) ?? []
    entries.push(role)
    rolesByRegion.set(role.valueRole.regionId, entries)
  }
  const regions = [...rolesByRegion.entries()].sort((first, second) => {
    const firstWeight = first[1].reduce((sum, role) => sum + role.weight, 0)
    const secondWeight = second[1].reduce((sum, role) => sum + role.weight, 0)
    return secondWeight - firstWeight || first[0].localeCompare(second[0])
  })
  for (const [regionId, regionRoles] of regions) {
    const orderedRoles = [...regionRoles].sort((first, second) =>
      first.valueRole.targetLightness - second.valueRole.targetLightness
      || first.valueRole.id.localeCompare(second.valueRole.id))
    const strict = solveRegion(orderedRoles, selectedColors, remaining, input.distanceMethod, 1, true)
    const monotone = strict ?? solveRegion(orderedRoles, selectedColors, remaining, input.distanceMethod, 0, true)
    const solution = monotone ?? solveRegion(orderedRoles, selectedColors, remaining, input.distanceMethod, 0, false)
    if (solution === undefined) throw new RangeError('Palette inventory cannot cover all planned roles')
    if (strict === undefined) relaxedRegionIds.push(regionId)
    orderedRoles.forEach((role, index) => {
      const colorId = solution.assignments[index]!
      assignments[role.valueRole.id] = colorId
      remaining[colorId] = remaining[colorId]! - role.demand
      inventoryUse[colorId] = (inventoryUse[colorId] ?? 0) + role.demand
    })
  }
  return { assignments, relaxedRegionIds, inventoryUse }
}

export function buildPalettePlan(input: PalettePlanningInput): PalettePlanningResult {
  validateInput(input)
  const colors = prepareColors(input.colors)
  const roles = buildRoles(input, colors)
  const selectedColors = selectColors(input, colors, roles)
  const assignment = assignRoles(input, roles, selectedColors)
  const allowedColorIdsByRole = Object.fromEntries(roles.map((role) => {
    const selectedAllowed = role.allowedColors
      .filter((color) => selectedColors.some((selected) => selected.id === color.id))
      .map((color) => color.id)
    const assignedColorId = assignment.assignments[role.valueRole.id]!
    return [role.valueRole.id, selectedAllowed.includes(assignedColorId)
      ? selectedAllowed
      : [...selectedAllowed, assignedColorId]]
  }))
  const fallbackColorId = selectedColors[0]!.id
  const colorIds = input.roleIdsByCell.map((roleId) =>
    roleId === undefined ? fallbackColorId : assignment.assignments[roleId] ?? fallbackColorId)
  const weightedCost = roles.reduce((total, role) => {
    const color = selectedColors.find((entry) => entry.id === assignment.assignments[role.valueRole.id])!
    return total + roleCost(role.colorRole, color, input.distanceMethod) * role.weight
  }, 0)
  const totalWeight = roles.reduce((sum, role) => sum + role.weight, 0)
  const plan: PalettePlan = {
    selectedColorIds: selectedColors.map((color) => color.id),
    assignments: assignment.assignments,
    allowedColorIdsByRole,
    totalCost: clamp(weightedCost / Math.max(1, totalWeight), 0, Number.MAX_SAFE_INTEGER),
  }
  validatePalettePlan(plan)
  const colorById = new Map(colors.map((color) => [color.id, color]))
  let orderedPairs = 0
  let validPairs = 0
  const rolesByRegion = new Map<string, PlannedRole[]>()
  for (const role of roles) {
    const entries = rolesByRegion.get(role.valueRole.regionId) ?? []
    entries.push(role)
    rolesByRegion.set(role.valueRole.regionId, entries)
  }
  for (const regionRoles of rolesByRegion.values()) {
    const ordered = [...regionRoles].sort((first, second) =>
      first.valueRole.targetLightness - second.valueRole.targetLightness)
    for (let index = 1; index < ordered.length; index += 1) {
      orderedPairs += 1
      const previous = colorById.get(assignment.assignments[ordered[index - 1]!.valueRole.id]!)!
      const current = colorById.get(assignment.assignments[ordered[index]!.valueRole.id]!)!
      if (current.lab[0] - previous.lab[0] >= ordered[index]!.valueRole.minimumSeparation) validPairs += 1
    }
  }
  const substitutions = roles.flatMap((role): readonly PaletteSubstitutionDiagnostic[] => {
    const selectedColorId = assignment.assignments[role.valueRole.id]!
    return input.substituteColorIds?.[role.preferredColorId]?.includes(selectedColorId) === true
      ? [{ roleId: role.valueRole.id, preferredColorId: role.preferredColorId, selectedColorId }]
      : []
  })
  return {
    plan,
    colorRoles: roles.map((role) => role.colorRole),
    colorIds,
    diagnostics: {
      roleOrderAccuracy: orderedPairs === 0 ? 1 : validPairs / orderedPairs,
      relaxedRegionIds: assignment.relaxedRegionIds,
      substitutions,
      inventoryUse: assignment.inventoryUse,
    },
  }
}
