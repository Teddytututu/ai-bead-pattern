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
import type {
  ColorDistanceMethod,
  Lab,
  MaterialColor,
} from '../types.js'
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
}

export interface PalettePlanningResult {
  plan: PalettePlan
  colorRoles: readonly ColorRole[]
  colorIds: readonly string[]
}

interface PlannedRole {
  valueRole: ValueRole
  colorRole: ColorRole
  allowedColors: readonly PreparedColor[]
  weight: number
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
}

function buildRoles(input: PalettePlanningInput, colors: readonly PreparedColor[]): readonly PlannedRole[] {
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
    const hueCompatible = colors.filter((color) =>
      colorRole.allowedHueShift >= 180
        || Math.hypot(color.lab[1], color.lab[2]) < 6
        || hueDifference(colorRole.idealLab, color.lab) <= colorRole.allowedHueShift)
    const allowedColors = (hueCompatible.length === 0 ? colors : hueCompatible)
      .map((color) => ({ color, cost: roleCost(colorRole, color, input.distanceMethod) }))
      .sort((first, second) => first.cost - second.cost || first.color.id.localeCompare(second.color.id))
      .slice(0, 12)
      .map((entry) => entry.color)
    return {
      valueRole,
      colorRole,
      allowedColors,
      weight: Math.max(0.05, cells.length * Math.max(0.1, valueRole.importance)),
    }
  })
}

function assignmentCost(
  roles: readonly PlannedRole[],
  selected: ReadonlySet<string>,
  colors: readonly PreparedColor[],
  method: ColorDistanceMethod,
): number {
  if (selected.size === 0) return Number.POSITIVE_INFINITY
  const selectedColors = colors.filter((color) => selected.has(color.id))
  return roles.reduce((total, role) => {
    const candidates = role.allowedColors.filter((color) => selected.has(color.id))
    const pool = candidates.length === 0
      ? selectedColors
      : candidates
    const best = pool.reduce((minimum, color) =>
      Math.min(minimum, roleCost(role.colorRole, color, method)), Number.POSITIVE_INFINITY)
    return total + best * role.weight
  }, 0)
}

function selectColors(
  input: PalettePlanningInput,
  colors: readonly PreparedColor[],
  roles: readonly PlannedRole[],
): readonly PreparedColor[] {
  const selected = new Set<string>()
  const featureRoles = new Set(input.featurePlacements.flatMap((placement) =>
    placement.roles.map((entry) => entry.role)))
  if ([...featureRoles].some((role) => role.endsWith('-dark'))) {
    selected.add([...colors].sort((first, second) =>
      first.lab[0] - second.lab[0] || first.id.localeCompare(second.id))[0]!.id)
  }
  if (featureRoles.has('eye-highlight') && selected.size < input.maximumColors) {
    selected.add([...colors].sort((first, second) =>
      second.lab[0] - first.lab[0] || first.id.localeCompare(second.id))[0]!.id)
  }
  while (selected.size < input.maximumColors) {
    let bestColor: PreparedColor | undefined
    let bestCost = Number.POSITIVE_INFINITY
    for (const color of colors) {
      if (selected.has(color.id)) continue
      const trial = new Set(selected).add(color.id)
      const cost = assignmentCost(roles, trial, colors, input.distanceMethod)
      if (cost < bestCost
        || (cost === bestCost && color.id.localeCompare(bestColor?.id ?? '') < 0)) {
        bestCost = cost
        bestColor = color
      }
    }
    if (bestColor === undefined) break
    selected.add(bestColor.id)
  }
  return colors.filter((color) => selected.has(color.id))
}

function assignRoles(
  roles: readonly PlannedRole[],
  selectedColors: readonly PreparedColor[],
  method: ColorDistanceMethod,
): Readonly<Record<string, string>> {
  const assignments: Record<string, string> = {}
  const rolesByRegion = new Map<string, PlannedRole[]>()
  for (const role of roles) {
    const entries = rolesByRegion.get(role.valueRole.regionId) ?? []
    entries.push(role)
    rolesByRegion.set(role.valueRole.regionId, entries)
  }
  for (const regionRoles of rolesByRegion.values()) {
    const ordered = [...regionRoles].sort((first, second) =>
      first.valueRole.targetLightness - second.valueRole.targetLightness)
    let previousLightness = -Infinity
    for (const role of ordered) {
      const allowedIds = new Set(role.allowedColors.map((color) => color.id))
      const compatible = selectedColors.filter((color) => allowedIds.has(color.id))
      const candidates = compatible.length === 0 ? selectedColors : compatible
      const selected = [...candidates].sort((first, second) => {
        const firstOrderPenalty = Math.max(0, previousLightness + role.valueRole.minimumSeparation - first.lab[0]) * 4
        const secondOrderPenalty = Math.max(0, previousLightness + role.valueRole.minimumSeparation - second.lab[0]) * 4
        const firstCost = roleCost(role.colorRole, first, method) + firstOrderPenalty
        const secondCost = roleCost(role.colorRole, second, method) + secondOrderPenalty
        return firstCost - secondCost || first.id.localeCompare(second.id)
      })[0]!
      assignments[role.valueRole.id] = selected.id
      previousLightness = Math.max(previousLightness, selected.lab[0])
    }
  }
  return assignments
}

export function buildPalettePlan(input: PalettePlanningInput): PalettePlanningResult {
  validateInput(input)
  const colors = prepareColors(input.colors)
  const roles = buildRoles(input, colors)
  const selectedColors = selectColors(input, colors, roles)
  const assignments = assignRoles(roles, selectedColors, input.distanceMethod)
  const allowedColorIdsByRole = Object.fromEntries(roles.map((role) => {
    const selectedAllowed = role.allowedColors.filter((color) =>
      selectedColors.some((selected) => selected.id === color.id)).map((color) => color.id)
    return [role.valueRole.id, selectedAllowed.length === 0
      ? selectedColors.map((color) => color.id)
      : selectedAllowed]
  }))
  const fallbackColorId = selectedColors[0]!.id
  const colorIds = input.roleIdsByCell.map((roleId) =>
    roleId === undefined ? fallbackColorId : assignments[roleId] ?? fallbackColorId)
  const weightedCost = roles.reduce((total, role) => {
    const color = selectedColors.find((entry) => entry.id === assignments[role.valueRole.id])!
    return total + roleCost(role.colorRole, color, input.distanceMethod) * role.weight
  }, 0)
  const totalWeight = roles.reduce((sum, role) => sum + role.weight, 0)
  const plan: PalettePlan = {
    selectedColorIds: selectedColors.map((color) => color.id),
    assignments,
    allowedColorIdsByRole,
    totalCost: clamp(weightedCost / Math.max(1, totalWeight), 0, Number.MAX_SAFE_INTEGER),
  }
  validatePalettePlan(plan)
  return { plan, colorRoles: roles.map((role) => role.colorRole), colorIds }
}
