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

export interface PalettePlanningInput {
  /** Keep local color evidence instead of flattening every tonal role to one color. */
  preserveCellColors?: boolean
  valuePlan: ValuePlan
  roleIdsByCell: readonly (string | undefined)[]
  plannedLabs: readonly Lab[]
  structurePlan: StructurePlan
  colors: readonly MaterialColor[]
  maximumColors: number
  distanceMethod: ColorDistanceMethod
  requiredColorIds?: readonly string[]
  /** Automatic fill exclusions; stock still describes the complete catalog. */
  excludedColorIds?: readonly string[]
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
  /** Scoped to one plan, with this palette's prepared colors and distance method. */
  costs: ReadonlyMap<PreparedColor, number>
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
  const excluded = new Set(input.excludedColorIds ?? [])
  if ([...excluded].some(id => !colorIds.has(id)) || excluded.size === colorIds.size) throw new RangeError('Fill exclusions must leave at least one known material color')
  if ((input.requiredColorIds?.length ?? 0) > input.maximumColors
    || new Set(input.requiredColorIds ?? []).size !== (input.requiredColorIds?.length ?? 0)
    || (input.requiredColorIds ?? []).some((colorId) => colorIds.has(colorId) === false
      || excluded.has(colorId) || stock(input, colorId) <= 0)) {
    throw new RangeError('Required palette colors must be unique, stocked, known, and within the color limit')
  }
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
  const finiteCapacity = input.colors.filter(color => !excluded.has(color.id)).reduce((sum, color) => sum + stock(input, color.id), 0)
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
    const costs = new Map(allColors.map(color => [color, roleCost(colorRole, color, input.distanceMethod)]))
    const preferred = [...allColors].sort((first, second) =>
      costs.get(first)! - costs.get(second)!
      || first.id.localeCompare(second.id))[0]!
    const idealChroma = Math.hypot(colorRole.idealLab[1], colorRole.idealLab[2])
    const hueCompatible = allColors.filter((color) =>
      stock(input, color.id) >= cells.length
      && (idealChroma < 8
        ? Math.hypot(color.lab[1], color.lab[2]) <= 12
        : colorRole.allowedHueShift >= 180
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
        cost: costs.get(color)!,
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
      costs,
    }
  })
}

function assignmentCost(
  roles: readonly PlannedRole[],
  selected: ReadonlySet<string>,
): number {
  if (selected.size === 0) return Number.POSITIVE_INFINITY
  return roles.reduce((total, role) => {
    const candidates = role.allowedColors.filter((color) => selected.has(color.id))
    if (candidates.length === 0) return total + 1_000_000 * role.weight
    const best = candidates.reduce((minimum, color) =>
      Math.min(minimum, role.costs.get(color)!), Number.POSITIVE_INFINITY)
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
  const selected = new Set<string>(input.requiredColorIds ?? [])
  while (selected.size < Math.min(input.maximumColors, selectable.length)) {
    let bestColor: PreparedColor | undefined
    let bestCost = Number.POSITIVE_INFINITY
    for (const color of selectable) {
      if (selected.has(color.id)) continue
      const trial = new Set(selected).add(color.id)
      const cost = assignmentCost(roles, trial)
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
        role.costs.get(first)! - role.costs.get(second)!
        || first.id.localeCompare(second.id))
    for (const color of candidates) {
      const next = { ...capacities, [color.id]: capacities[color.id]! - role.demand }
      visit(index + 1, color.lab[0], next, [...assignments, color.id],
        cost + role.costs.get(color)! * role.weight)
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
    const strict = solveRegion(orderedRoles, selectedColors, remaining, 1, true)
    const monotone = strict ?? solveRegion(orderedRoles, selectedColors, remaining, 0, true)
    const solution = monotone ?? solveRegion(orderedRoles, selectedColors, remaining, 0, false)
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
  if (input.preserveCellColors) return buildCellPalettePlan(input)
  const colors = prepareColors(input.colors).filter(color => !input.excludedColorIds?.includes(color.id))
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
    return total + role.costs.get(color)! * role.weight
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

/** Choose a bounded material subset from cell evidence, then allocate individual beads. */
function buildCellPalettePlan(input: PalettePlanningInput): PalettePlanningResult {
  const colors = prepareColors(input.colors).filter(color => !input.excludedColorIds?.includes(color.id))
  const available = colors.filter(color => stock(input, color.id) > 0)
  const active = input.roleIdsByCell.flatMap((roleId, cell) => roleId === undefined ? [] : [cell])
  const roles = new Map(input.valuePlan.roles.map(role => [role.id, role]))
  const distances = input.plannedLabs.map(lab => colors.map(color => colorDistance(lab, color.lab, input.distanceMethod)))
  const indexById = new Map(colors.map((color, index) => [color.id, index]))
  const weights = input.roleIdsByCell.map(id => Math.max(0.1, roles.get(id ?? '')?.importance ?? 0.1))
  const selected = new Set(input.requiredColorIds ?? [])
  const finiteStock = input.inventory !== undefined && Object.keys(input.inventory).length > 0
  // Aggregate subset-selection costs by nearest physical color. This bounds the
  // greedy search to paletteSize buckets; final bead assignment still uses each cell's Lab.
  const availableIndices = available.map(color => indexById.get(color.id)!)
  const buckets = new Map<number, Float64Array>()
  for (const cell of active) {
    const row = distances[cell]!
    const nearest = availableIndices.reduce((best, index) => row[index]! < row[best]! ? index : best)
    const costs = buckets.get(nearest) ?? new Float64Array(colors.length)
    for (let index = 0; index < colors.length; index++) costs[index] = costs[index]! + row[index]! * weights[cell]!
    buckets.set(nearest, costs)
  }
  const demands = [...buckets.values()]
  const best = new Float64Array(demands.length).fill(Number.POSITIVE_INFINITY)
  const include = (id: string): void => {
    selected.add(id)
    const index = indexById.get(id)!
    for (let bucket = 0; bucket < demands.length; bucket++) best[bucket] = Math.min(best[bucket]!, demands[bucket]![index]!)
  }
  for (const id of selected) include(id)
  while (selected.size < Math.min(input.maximumColors, available.length)) {
    let chosen: PreparedColor | undefined
    let bestCost = Number.POSITIVE_INFINITY
    const selectedCapacity = finiteStock ? [...selected].reduce((sum, id) => sum + stock(input, id), 0) : Number.POSITIVE_INFINITY
    for (const color of available) {
      if (selected.has(color.id)) continue
      if (selectedCapacity < active.length) {
        const remainingSlots = input.maximumColors - selected.size - 1
        const capacity = selectedCapacity + stock(input, color.id) + available
          .filter(other => other.id !== color.id && !selected.has(other.id))
          .map(other => stock(input, other.id)).sort((a, b) => b - a)
          .slice(0, remainingSlots).reduce((sum, value) => sum + value, 0)
        if (capacity < active.length) continue
      }
      const index = indexById.get(color.id)!
      let cost = 0
      for (let bucket = 0; bucket < demands.length; bucket++) cost += Math.min(best[bucket]!, demands[bucket]![index]!)
      if (cost < bestCost || (cost === bestCost && color.id.localeCompare(chosen?.id ?? '') < 0)) {
        chosen = color
        bestCost = cost
      }
    }
    if (!chosen) break
    include(chosen.id)
  }
  const selectedColors = colors.filter(color => selected.has(color.id))
  const remaining = new Map(selectedColors.map(color => [color.id, stock(input, color.id)]))
  if (!selectedColors.length || [...remaining.values()].reduce((sum, value) => sum + value, 0) < active.length) {
    throw new RangeError('Palette inventory cannot cover all planned cells within the color limit')
  }
  const ranked = active.map(cell => {
    const ordered = [...selectedColors].sort((a, b) => distances[cell]![indexById.get(a.id)!]! - distances[cell]![indexById.get(b.id)!]! || a.id.localeCompare(b.id))
    const regret = ordered.length < 2 ? 0 : distances[cell]![indexById.get(ordered[1]!.id)!]! - distances[cell]![indexById.get(ordered[0]!.id)!]!
    return { cell, ordered, regret }
  }).sort((a, b) => b.regret - a.regret || a.cell - b.cell)
  const colorIds = input.plannedLabs.map(() => selectedColors[0]!.id)
  const inventoryUse: Record<string, number> = {}
  const countsByRole = new Map<string, Map<string, number>>()
  const substitutions = new Map<string, PaletteSubstitutionDiagnostic>()
  let cost = 0
  let totalWeight = 0
  for (const { cell, ordered } of ranked) {
    const preferred = input.substituteColorIds === undefined ? undefined : colors.reduce((best, color) => {
      const difference = distances[cell]![indexById.get(color.id)!]! - distances[cell]![indexById.get(best.id)!]!
      return difference < 0 || (difference === 0 && color.id.localeCompare(best.id) < 0) ? color : best
    })
    const substitute = (input.substituteColorIds?.[preferred?.id ?? ''] ?? []).find(id => (remaining.get(id) ?? 0) > 0)
    const chosen = preferred !== undefined && (remaining.get(preferred.id) ?? 0) <= 0 && substitute !== undefined
      ? selectedColors.find(color => color.id === substitute)!
      : ordered.find(color => remaining.get(color.id)! > 0)!
    colorIds[cell] = chosen.id
    remaining.set(chosen.id, remaining.get(chosen.id)! - 1)
    inventoryUse[chosen.id] = (inventoryUse[chosen.id] ?? 0) + 1
    const roleId = input.roleIdsByCell[cell]!
    if (preferred && input.substituteColorIds?.[preferred.id]?.includes(chosen.id)) substitutions.set(`${roleId}|${preferred.id}|${chosen.id}`, { roleId, preferredColorId: preferred.id, selectedColorId: chosen.id })
    const counts = countsByRole.get(roleId) ?? new Map<string, number>()
    counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1)
    countsByRole.set(roleId, counts)
    cost += distances[cell]![indexById.get(chosen.id)!]! * weights[cell]!
    totalWeight += weights[cell]!
  }
  const assignments: Record<string, string> = {}
  const allowedColorIdsByRole: Record<string, string[]> = {}
  for (const role of input.valuePlan.roles) {
    const counts = countsByRole.get(role.id)
    assignments[role.id] = counts ? [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] : selectedColors[0]!.id
    allowedColorIdsByRole[role.id] = counts ? [...counts.keys()].sort() : [selectedColors[0]!.id]
  }
  const plan: PalettePlan = { assignmentMode: 'per-cell', cellColorIds: colorIds, selectedColorIds: selectedColors.map(color => color.id), assignments, allowedColorIdsByRole, totalCost: cost / Math.max(1, totalWeight) }
  validatePalettePlan(plan)
  let pairs = 0, orderedPairs = 0
  const relaxedRegionIds = new Set<string>()
  const byRegion = new Map<string, ValueRole[]>()
  for (const role of input.valuePlan.roles) {
    if (!countsByRole.has(role.id)) continue
    const group = byRegion.get(role.regionId) ?? []
    group.push(role)
    byRegion.set(role.regionId, group)
  }
  const meanLightness = (id: string): number => {
    const counts = [...countsByRole.get(id)!]
    return counts.reduce((sum, [colorId, count]) => sum + colors[indexById.get(colorId)!]!.lab[0] * count, 0) / counts.reduce((sum, [, count]) => sum + count, 0)
  }
  for (const [regionId, group] of byRegion) {
    group.sort((a, b) => a.targetLightness - b.targetLightness || a.id.localeCompare(b.id))
    for (let index = 1; index < group.length; index++) {
      pairs++
      if (meanLightness(group[index]!.id) - meanLightness(group[index - 1]!.id) + 1e-9 >= group[index]!.minimumSeparation) orderedPairs++
      else relaxedRegionIds.add(regionId)
    }
  }
  return { plan, colorRoles: [], colorIds, diagnostics: { roleOrderAccuracy: pairs === 0 ? 1 : orderedPairs / pairs, relaxedRegionIds: [...relaxedRegionIds].sort(), substitutions: [...substitutions.values()], inventoryUse } }
}
