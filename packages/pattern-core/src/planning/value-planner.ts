import {
  validateStructurePlan,
  validateValuePlan,
  type StructurePlan,
  type ValuePlan,
  type ValueRole,
  type ValueRoleKind,
} from '../contracts.js'
import type { Lab } from '../types.js'

export interface ValuePlanningInput {
  structurePlan: StructurePlan
  pixelLabs: readonly Lab[]
  activeMask: Uint8Array
  levels: 2 | 3 | 4
}

export interface ValuePlanningResult {
  plan: ValuePlan
  roleIdsByCell: readonly (string | undefined)[]
  plannedLabs: readonly Lab[]
}

interface RoleDefinition {
  kind: ValueRoleKind
  quantile: number
  importanceScale: number
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
    { kind: 'outline', quantile: 0.08, importanceScale: 0.95 },
    { kind: 'shadow', quantile: 0.3, importanceScale: 0.9 },
    { kind: 'base', quantile: 0.62, importanceScale: 1 },
    { kind: 'light', quantile: 0.9, importanceScale: 0.82 },
  ],
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
    for (let index = 0; index < targets.length; index += 1) {
      targets[index] = targets[index]! - overflow
    }
  }
  for (let index = targets.length - 2; index >= 0; index -= 1) {
    targets[index] = Math.min(targets[index]!, targets[index + 1]! - minimumSeparation)
  }
  return targets.map((value) => clamp(value, 0, 100))
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
}

export function buildValuePlan(input: ValuePlanningInput): ValuePlanningResult {
  validateInput(input)
  const roles: ValueRole[] = []
  const roleIdsByCell: Array<string | undefined> = new Array(input.activeMask.length)
  const plannedLabs = input.pixelLabs.map((lab) => [...lab] as Lab)
  const definitions = roleDefinitions[input.levels]
  for (const region of input.structurePlan.regions) {
    const cells = region.cellIndices.filter((cell) => input.activeMask[cell] === 1)
    if (cells.length === 0) continue
    const lightness = cells.map((cell) => input.pixelLabs[cell]![0])
      .sort((first, second) => first - second)
    const minimumSeparation = input.levels === 2 ? 8 : 6
    const targets = separatedTargets(
      definitions.map((definition) => quantile(lightness, definition.quantile)),
      minimumSeparation,
    )
    const meanA = cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![1], 0) / cells.length
    const meanB = cells.reduce((sum, cell) => sum + input.pixelLabs[cell]![2], 0) / cells.length
    const regionRoles = definitions.map((definition, index): ValueRole => ({
      id: `region-${region.id}:${definition.kind}`,
      regionId: String(region.id),
      kind: definition.kind,
      targetLightness: targets[index]!,
      minimumSeparation,
      importance: clamp(region.importance * definition.importanceScale, 0, 1),
    }))
    roles.push(...regionRoles)
    for (const cell of cells) {
      const sourceLightness = input.pixelLabs[cell]![0]
      let role = regionRoles.reduce((best, candidate) =>
        Math.abs(candidate.targetLightness - sourceLightness)
          < Math.abs(best.targetLightness - sourceLightness)
          ? candidate
          : best)
      const outline = regionRoles.find((candidate) => candidate.kind === 'outline')
      if (outline !== undefined
        && input.structurePlan.boundaryStrength[cell]! >= 0.65
        && sourceLightness <= regionRoles.find((candidate) => candidate.kind === 'base')!.targetLightness) {
        role = outline
      }
      roleIdsByCell[cell] = role.id
      plannedLabs[cell] = [role.targetLightness, meanA, meanB]
    }
  }
  const plan = { roles: roles.sort((first, second) => first.id.localeCompare(second.id)) }
  validateValuePlan(plan)
  return { plan, roleIdsByCell, plannedLabs }
}
