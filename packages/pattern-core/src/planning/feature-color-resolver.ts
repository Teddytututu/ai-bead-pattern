import { colorDistance, prepareColors, type PreparedColor } from '../color.js'
import type {
  ColorDistanceMethod,
  GridEditRecord,
  Lab,
  MaterialColor,
} from '../types.js'
import {
  validateResolvedFeaturePlacement,
  type ResolvedFeaturePlacement,
} from './feature-placement.js'
import type { FeatureCellRole } from './feature-template.js'

export interface FeatureColorResolutionInput {
  placements: readonly ResolvedFeaturePlacement[]
  initialColorIds: readonly string[]
  colors: readonly MaterialColor[]
  width: number
  height: number
  activeMask?: Uint8Array
  minimumContrastByFeature?: ReadonlyMap<string, number>
  distanceMethod: ColorDistanceMethod
}

export interface FeatureColorResolutionResult {
  colorIds: readonly string[]
  roleColorIds: Readonly<Partial<Record<FeatureCellRole, string>>>
  edits: readonly GridEditRecord[]
}

const roleOrder: readonly FeatureCellRole[] = [
  'eye-dark',
  'eye-highlight',
  'mouth-dark',
  'mouth-inner',
  'nose-base',
  'ear-tip',
  'identity-dark',
  'endpoint-dark',
]

function validateInput(input: FeatureColorResolutionInput, colors: readonly PreparedColor[]): void {
  if (Number.isInteger(input.width) === false || input.width <= 0
    || Number.isInteger(input.height) === false || input.height <= 0) {
    throw new RangeError('Feature color grid dimensions must be positive integers')
  }
  const cells = input.width * input.height
  if (input.initialColorIds.length !== cells) {
    throw new RangeError('Feature color assignments must align with the target grid')
  }
  if (input.activeMask !== undefined && input.activeMask.length !== cells) {
    throw new RangeError('Feature color occupancy must align with the target grid')
  }
  if (colors.length === 0 || new Set(colors.map((color) => color.id)).size !== colors.length) {
    throw new RangeError('Feature color palette requires unique colors')
  }
  for (const placement of input.placements) {
    validateResolvedFeaturePlacement(placement, { width: input.width, height: input.height })
    const minimumContrast = input.minimumContrastByFeature?.get(placement.featureId)
    if (minimumContrast !== undefined
      && (Number.isFinite(minimumContrast) === false || minimumContrast < 0)) {
      throw new RangeError('Feature color contrast must be finite and non-negative')
    }
  }
  if (input.activeMask?.some((value) => value !== 0 && value !== 1) === true) {
    throw new RangeError('Feature color occupancy must contain binary values')
  }
  const colorIds = new Set(colors.map((color) => color.id))
  for (let index = 0; index < cells; index += 1) {
    if ((input.activeMask?.[index] ?? 1) === 1 && colorIds.has(input.initialColorIds[index]!) === false) {
      throw new RangeError('Feature color assignments must reference the supplied palette')
    }
  }
}

function averageLab(labs: readonly Lab[]): Lab {
  const total = labs.reduce((sum, lab) => [
    sum[0] + lab[0],
    sum[1] + lab[1],
    sum[2] + lab[2],
  ] as Lab, [0, 0, 0] as Lab)
  return [total[0] / labs.length, total[1] / labs.length, total[2] / labs.length]
}

function rankedColor(
  colors: readonly PreparedColor[],
  score: (color: PreparedColor) => number,
): PreparedColor {
  return [...colors].sort((first, second) =>
    score(second) - score(first) || first.id.localeCompare(second.id))[0]!
}

function selectDark(
  colors: readonly PreparedColor[],
  carrier: Lab,
  minimumContrast: number,
  method: ColorDistanceMethod,
  preferred?: PreparedColor,
): PreparedColor {
  if (preferred !== undefined
    && preferred.lab[0] < carrier[0]
    && colorDistance(carrier, preferred.lab, method) >= minimumContrast) return preferred
  return rankedColor(colors, (color) => {
    const contrast = colorDistance(carrier, color.lab, method)
    const darkness = Math.max(0, carrier[0] - color.lab[0])
    const reachesContrast = contrast >= minimumContrast ? 1_000 : 0
    const staysDarker = color.lab[0] < carrier[0] ? 200 : 0
    return reachesContrast + staysDarker + darkness * 1.25 + contrast
  })
}

function selectHighlight(
  colors: readonly PreparedColor[],
  eyeDark: PreparedColor,
  method: ColorDistanceMethod,
  preferred?: PreparedColor,
): PreparedColor {
  if (preferred !== undefined
    && preferred.lab[0] > eyeDark.lab[0]
    && colorDistance(eyeDark.lab, preferred.lab, method) >= 12) return preferred
  return rankedColor(colors, (color) => {
    const contrast = colorDistance(eyeDark.lab, color.lab, method)
    const lightnessGain = color.lab[0] - eyeDark.lab[0]
    const reachesContrast = contrast >= 12 ? 1_000 : 0
    const staysLighter = lightnessGain > 0 ? 200 : 0
    return reachesContrast + staysLighter + lightnessGain * 2 - Math.hypot(color.lab[1], color.lab[2]) * 0.1
  })
}

function selectMouthInner(
  colors: readonly PreparedColor[],
  carrier: Lab,
  mouthDark: PreparedColor,
  minimumContrast: number,
  method: ColorDistanceMethod,
  preferred?: PreparedColor,
): PreparedColor {
  if (preferred !== undefined
    && preferred.id !== mouthDark.id
    && colorDistance(carrier, preferred.lab, method) >= minimumContrast * 0.7) return preferred
  const alternatives = colors.filter((color) => color.id !== mouthDark.id)
  if (alternatives.length === 0) return mouthDark
  return rankedColor(alternatives, (color) => {
    const carrierContrast = colorDistance(carrier, color.lab, method)
    const separation = colorDistance(mouthDark.lab, color.lab, method)
    const chroma = Math.hypot(color.lab[1], color.lab[2])
    const redness = Math.max(0, color.lab[1])
    const darkness = Math.max(0, carrier[0] - color.lab[0])
    const reachesContrast = carrierContrast >= minimumContrast * 0.7 ? 1_000 : 0
    return reachesContrast + separation + chroma * 0.6 + redness * 0.4 + darkness * 0.4
  })
}

function selectNose(
  colors: readonly PreparedColor[],
  carrier: Lab,
  minimumContrast: number,
  method: ColorDistanceMethod,
  preferred?: PreparedColor,
): PreparedColor {
  if (preferred !== undefined
    && preferred.lab[0] < carrier[0]
    && colorDistance(carrier, preferred.lab, method) >= Math.max(3, minimumContrast * 0.4)) return preferred
  const targetContrast = Math.max(6, minimumContrast * 0.55)
  return rankedColor(colors, (color) => {
    const contrast = colorDistance(carrier, color.lab, method)
    const darkness = carrier[0] - color.lab[0]
    const staysDarker = darkness > 0 ? 200 : 0
    return staysDarker - Math.abs(contrast - targetContrast) * 2 - Math.abs(darkness - 10)
  })
}

export function resolveFeatureColors(
  input: FeatureColorResolutionInput,
): FeatureColorResolutionResult {
  const colors = prepareColors(input.colors)
  validateInput(input, colors)
  if (input.placements.length === 0) {
    return { colorIds: [...input.initialColorIds], roleColorIds: {}, edits: [] }
  }
  const colorsById = new Map(colors.map((color) => [color.id, color]))
  const entriesByRole = new Map<FeatureCellRole, { cell: number; featureId: string }[]>()
  const featureCells = new Set(input.placements.flatMap((placement) => placement.occupiedCells))
  for (const placement of input.placements) {
    for (const entry of placement.roles) {
      if ((input.activeMask?.[entry.cell] ?? 1) !== 1) continue
      const entries = entriesByRole.get(entry.role) ?? []
      entries.push({ cell: entry.cell, featureId: placement.featureId })
      entriesByRole.set(entry.role, entries)
    }
  }
  const carrierByRole = new Map<FeatureCellRole, Lab>()
  const minimumContrastByRole = new Map<FeatureCellRole, number>()
  const preferredByRole = new Map<FeatureCellRole, PreparedColor>()
  for (const [role, entries] of entriesByRole) {
    const neighborCells = new Set<number>()
    for (const entry of entries) {
      const x = entry.cell % input.width
      const y = Math.floor(entry.cell / input.width)
      for (const [offsetX, offsetY] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
        const next = nextY * input.width + nextX
        if (featureCells.has(next) || (input.activeMask?.[next] ?? 1) !== 1) continue
        neighborCells.add(next)
      }
    }
    const carrierCells = neighborCells.size > 0
      ? [...neighborCells]
      : entries.map((entry) => entry.cell)
    const labs = carrierCells.map((cell) => colorsById.get(input.initialColorIds[cell]!)!.lab)
    carrierByRole.set(role, averageLab(labs))
    const existingIds = new Set(entries.map((entry) => input.initialColorIds[entry.cell]!))
    if (existingIds.size === 1) preferredByRole.set(role, colorsById.get([...existingIds][0]!)!)
    minimumContrastByRole.set(role, Math.max(0, ...entries.map((entry) =>
      input.minimumContrastByFeature?.get(entry.featureId) ?? 0)))
  }
  const selected = new Map<FeatureCellRole, PreparedColor>()
  for (const role of roleOrder) {
    const carrier = carrierByRole.get(role)
    if (carrier === undefined) continue
    const minimumContrast = minimumContrastByRole.get(role) ?? 0
    const preferred = preferredByRole.get(role)
    const color = role === 'eye-highlight'
      ? selectHighlight(colors, selected.get('eye-dark') ?? selectDark(
        colors,
        carrier,
        minimumContrast,
        input.distanceMethod,
        preferred,
      ), input.distanceMethod, preferred)
      : role === 'mouth-inner'
        ? selectMouthInner(colors, carrier, selected.get('mouth-dark') ?? selectDark(
          colors,
          carrier,
          minimumContrast,
          input.distanceMethod,
          preferred,
        ), minimumContrast, input.distanceMethod, preferred)
        : role === 'nose-base'
          ? selectNose(colors, carrier, minimumContrast, input.distanceMethod, preferred)
          : selectDark(colors, carrier, minimumContrast, input.distanceMethod, preferred)
    selected.set(role, color)
  }
  const colorIds = [...input.initialColorIds]
  const edits: GridEditRecord[] = []
  for (const role of roleOrder) {
    const color = selected.get(role)
    if (color === undefined) continue
    for (const entry of entriesByRole.get(role) ?? []) {
      const fromColorId = colorIds[entry.cell]!
      colorIds[entry.cell] = color.id
      if (fromColorId === color.id) continue
      edits.push({
        x: entry.cell % input.width,
        y: Math.floor(entry.cell / input.width),
        fromColorId,
        toColorId: color.id,
        reason: 'feature-placement',
      })
    }
  }
  return {
    colorIds,
    roleColorIds: Object.fromEntries([...selected].map(([role, color]) => [role, color.id])),
    edits,
  }
}
