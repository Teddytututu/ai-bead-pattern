import { colorDistance, prepareColors, type PreparedColor } from '../color.js'
import type {
  BaselineMode,
  ColorDistanceMethod,
  Lab,
  MaterialColor,
  MaterialInventory,
  RGB,
} from '../types.js'
import type { GridEditRecord } from '../types.js'

/** Inputs shared by the fallback quantizer and the higher-level palette planner. */
export interface PaletteQuantizationInput {
  pixels: readonly RGB[]
  pixelLabs: readonly Lab[]
  weights: readonly number[]
  colors: readonly MaterialColor[]
  maximumColors: number
  baseline: BaselineMode
  distanceMethod: ColorDistanceMethod
  activeMask?: Uint8Array
  requiredColorIds?: readonly string[]
  inventory?: MaterialInventory
  distanceMatrixCache?: PaletteDistanceMatrixCache
}

export interface PaletteQuantizationResult {
  selectedColors: readonly PreparedColor[]
  colorIds: readonly string[]
}

export interface PaletteInventoryRepairInput {
  colorIds: readonly string[]
  width: number
  colors: readonly PreparedColor[]
  pixelLabs: readonly Lab[]
  activeMask: Uint8Array
  importance: readonly number[]
  protectedCells: ReadonlySet<number>
  inventory?: MaterialInventory
}

export interface PaletteInventoryRepairResult {
  colorIds: readonly string[]
  edits: readonly GridEditRecord[]
  valid: boolean
}

function stock(inventory: MaterialInventory | undefined, colorId: string): number {
  return inventory?.[colorId] ?? Number.POSITIVE_INFINITY
}

function validateInput(input: PaletteQuantizationInput, colors: readonly PreparedColor[]): void {
  if (input.pixels.length !== input.pixelLabs.length || input.pixels.length !== input.weights.length) {
    throw new RangeError('Palette quantization arrays must have equal lengths')
  }
  if (input.activeMask !== undefined && input.activeMask.length !== input.pixels.length) {
    throw new RangeError('Palette quantization active mask must align with the image grid')
  }
  if (colors.length === 0 || Number.isInteger(input.maximumColors) === false
    || input.maximumColors < 1 || input.maximumColors > colors.length) {
    throw new RangeError('Palette quantization requires a positive color limit within the available palette')
  }
  const colorIds = new Set(colors.map((color) => color.id))
  const required = input.requiredColorIds ?? []
  if (new Set(required).size !== required.length
    || required.length > input.maximumColors
    || required.some((colorId) => colorIds.has(colorId) === false || stock(input.inventory, colorId) <= 0)) {
    throw new RangeError('Required palette colors must be unique, stocked, known, and within the color limit')
  }
  for (const [colorId, quantity] of Object.entries(input.inventory ?? {})) {
    if (colorIds.has(colorId) === false || Number.isInteger(quantity) === false || quantity < 0) {
      throw new RangeError('Palette inventory must reference known colors with non-negative integer counts')
    }
  }
  const finiteCapacity = colors.reduce((sum, color) => sum + stock(input.inventory, color.id), 0)
  const activeCellCount = input.activeMask?.reduce((sum, value) => sum + (value === 1 ? 1 : 0), 0)
    ?? input.pixels.length
  if (Number.isFinite(finiteCapacity) && finiteCapacity < activeCellCount) {
    throw new RangeError('Palette inventory cannot cover all active cells')
  }
}

function distance(input: PaletteQuantizationInput, pixelIndex: number, color: PreparedColor): number {
  return input.baseline === 'a0'
    ? Math.sqrt(
      (input.pixels[pixelIndex]![0] - color.rgb[0]) ** 2
      + (input.pixels[pixelIndex]![1] - color.rgb[1]) ** 2
      + (input.pixels[pixelIndex]![2] - color.rgb[2]) ** 2,
    )
    : colorDistance(input.pixelLabs[pixelIndex]!, color.lab, input.distanceMethod)
}

type DistanceMatrix = readonly Float32Array[]

export type PaletteDistanceMatrixCache = Map<string, DistanceMatrix>

function matrixCacheKey(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
): string {
  let hash = 0x811c9dc5
  const add = (value: number): void => {
    const normalized = Number.isFinite(value) ? Math.round(value * 1000) : 0
    hash ^= normalized
    hash = Math.imul(hash, 0x01000193)
  }
  for (const color of colors) {
    for (const channel of color.lab) add(channel)
  }
  for (const lab of input.pixelLabs) {
    add(lab[0]); add(lab[1]); add(lab[2])
  }
  if (input.baseline === 'a0') {
    for (const pixel of input.pixels) {
      add(pixel[0]); add(pixel[1]); add(pixel[2])
    }
  }
  return `${input.baseline}:${input.distanceMethod}:${input.pixelLabs.length}:${hash >>> 0}`
}

function buildDistanceMatrix(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
): DistanceMatrix {
  return colors.map((color) => Float32Array.from(
    input.pixels.map((_pixel, index) => distance(input, index, color)),
  ))
}

function matrixDistance(matrix: DistanceMatrix, colorIndex: number, pixelIndex: number): number {
  return matrix[colorIndex]![pixelIndex]!
}

function selectColors(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
  matrix: DistanceMatrix,
): readonly PreparedColor[] {
  const selectable = colors.filter((color) => stock(input.inventory, color.id) > 0)
  if (selectable.length === 0) throw new RangeError('Palette inventory has no available colors')
  const limit = Math.min(input.maximumColors, selectable.length)
  const selected = new Set(input.requiredColorIds ?? [])
  const activeCellCount = input.activeMask?.reduce((sum, value) => sum + (value === 1 ? 1 : 0), 0)
    ?? input.pixels.length
  const canCoverDemand = (candidate: PreparedColor): boolean => {
    const trial = new Set(selected).add(candidate.id)
    const capacity = selectable
      .filter((color) => trial.has(color.id))
      .reduce((sum, color) => sum + stock(input.inventory, color.id), 0)
    const remainingSlots = limit - trial.size
    const extraCapacity = selectable
      .filter((color) => trial.has(color.id) === false)
      .sort((first, second) => stock(input.inventory, second.id) - stock(input.inventory, first.id))
      .slice(0, Math.max(0, remainingSlots))
      .reduce((sum, color) => sum + stock(input.inventory, color.id), 0)
    return capacity + extraCapacity >= activeCellCount
  }
  while (selected.size < limit) {
    let best: { color: PreparedColor; cost: number } | undefined
    for (const color of selectable) {
      if (selected.has(color.id)) continue
      if (canCoverDemand(color) === false) continue
      const colorIndex = colors.indexOf(color)
      let cost = 0
      for (let index = 0; index < input.pixelLabs.length; index += 1) {
        if (input.activeMask?.[index] === 0) continue
        let nearest = Number.POSITIVE_INFINITY
        for (const selectedColor of selectable) {
          if (selected.has(selectedColor.id)) {
            nearest = Math.min(nearest, matrixDistance(matrix, colors.indexOf(selectedColor), index))
          }
        }
        cost += Math.min(nearest, matrixDistance(matrix, colorIndex, index)) * (input.weights[index] ?? 1)
      }
      if (best === undefined || cost < best.cost
        || (cost === best.cost && color.id.localeCompare(best.color.id) < 0)) {
        best = { color, cost }
      }
    }
    if (best === undefined) break
    selected.add(best.color.id)
  }
  return colors.filter((color) => selected.has(color.id))
}

function candidateOrder(
  pixelIndex: number,
  colors: readonly PreparedColor[],
  matrix: DistanceMatrix,
  remaining: Readonly<Record<string, number>>,
): readonly PreparedColor[] {
  const ranked = colors
    .filter((color) => (remaining[color.id] ?? Number.POSITIVE_INFINITY) > 0)
    .map((color) => ({ color, cost: matrixDistance(matrix, colors.indexOf(color), pixelIndex) }))
    .sort((first, second) => first.cost - second.cost || first.color.id.localeCompare(second.color.id))
  if (ranked.length === 0) return []
  return ranked.map((entry) => entry.color)
}

function assignColors(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
  matrix: DistanceMatrix,
): readonly string[] {
  const remaining: Record<string, number> = Object.fromEntries(
    colors.map((color) => [color.id, stock(input.inventory, color.id)]),
  )
  const order = Array.from({ length: input.pixels.length }, (_value, index) => index)
    .filter((index) => input.activeMask?.[index] !== 0)
    .sort((first, second) =>
    (input.weights[second] ?? 1) - (input.weights[first] ?? 1) || first - second)
  const colorIds = new Array<string>(input.pixels.length)
  for (const index of order) {
    const candidate = candidateOrder(index, colors, matrix, remaining)[0]
    if (candidate === undefined) throw new RangeError('Palette inventory cannot cover all active cells')
    colorIds[index] = candidate.id
    remaining[candidate.id] = remaining[candidate.id]! - 1
  }
  const fallback = colors[0]!.id
  for (let index = 0; index < colorIds.length; index += 1) {
    colorIds[index] ??= fallback
  }
  return colorIds
}

/** Deterministic finite-palette selection followed by inventory-aware nearest-color assignment. */
export function quantizePalette(input: PaletteQuantizationInput): PaletteQuantizationResult {
  const colors = prepareColors(input.colors)
  validateInput(input, colors)
  const cache = input.distanceMatrixCache
  const key = cache === undefined ? undefined : matrixCacheKey(input, colors)
  const cached = key === undefined || cache === undefined ? undefined : cache.get(key)
  const matrix = cached ?? buildDistanceMatrix(input, colors)
  if (cache !== undefined && key !== undefined && cache.has(key) === false) {
    cache.set(key, matrix)
    // Keep the shared cache bounded across large multi-candidate generations.
    // A generation revisits adjacent style/size pairs, so twelve matrices retain
    // the useful locality while keeping peak memory predictable.
    while (cache.size > 12) cache.delete(cache.keys().next().value!)
  }
  const selectedColors = selectColors(input, colors, matrix)
  const selectedMatrix = selectedColors.map((color) => matrix[colors.indexOf(color)]!)
  return { selectedColors, colorIds: assignColors(input, selectedColors, selectedMatrix) }
}

/** Repairs post-quantization edits so finite material stock remains a hard output constraint. */
export function enforcePaletteInventory(
  input: PaletteInventoryRepairInput,
): PaletteInventoryRepairResult {
  if (input.inventory === undefined) {
    return { colorIds: [...input.colorIds], edits: [], valid: true }
  }
  if (input.colorIds.length !== input.pixelLabs.length || input.colorIds.length !== input.activeMask.length) {
    throw new RangeError('Palette inventory repair arrays must align with the image grid')
  }
  const colorsById = new Map(input.colors.map((color) => [color.id, color]))
  const usage = new Map<string, number>()
  for (let index = 0; index < input.colorIds.length; index += 1) {
    if (input.activeMask[index] !== 1) continue
    const colorId = input.colorIds[index]!
    usage.set(colorId, (usage.get(colorId) ?? 0) + 1)
  }
  const finite = [...usage.keys()].filter((colorId) => Number.isFinite(input.inventory?.[colorId]))
  if (finite.every((colorId) => usage.get(colorId)! <= input.inventory![colorId]!)) {
    return { colorIds: [...input.colorIds], edits: [], valid: true }
  }
  const repaired = [...input.colorIds]
  const edits: GridEditRecord[] = []
  const overused = (): string | undefined => finite
    .filter((colorId) => (usage.get(colorId) ?? 0) > input.inventory![colorId]!)
    .sort((first, second) => first.localeCompare(second))[0]
  while (true) {
    const sourceColorId = overused()
    if (sourceColorId === undefined) break
    const donorCells = repaired.flatMap((colorId, index) =>
      colorId === sourceColorId && input.activeMask[index] === 1 && !input.protectedCells.has(index)
        ? [index]
        : [],
    ).sort((first, second) =>
      (input.importance[first] ?? 1) - (input.importance[second] ?? 1) || first - second)
    if (donorCells.length === 0) {
      return { colorIds: repaired, edits, valid: false }
    }
    let best: { index: number; colorId: string; cost: number } | undefined
    for (const index of donorCells) {
      const current = colorsById.get(sourceColorId)
      if (current === undefined) continue
      for (const candidate of input.colors) {
        const capacity = input.inventory[candidate.id] ?? Number.POSITIVE_INFINITY
        const currentUsage = usage.get(candidate.id) ?? 0
        if (candidate.id === sourceColorId
          || (Number.isFinite(capacity) && currentUsage >= capacity)) continue
        const cost = colorDistance(input.pixelLabs[index]!, candidate.lab, 'delta-e-2000')
          - colorDistance(input.pixelLabs[index]!, current.lab, 'delta-e-2000')
          + (input.importance[index] ?? 1) * 0.01
        if (best === undefined || cost < best.cost
          || (cost === best.cost && (index < best.index
            || (index === best.index && candidate.id.localeCompare(best.colorId) < 0)))) {
          best = { index, colorId: candidate.id, cost }
        }
      }
    }
    if (best === undefined) return { colorIds: repaired, edits, valid: false }
    const fromColorId = repaired[best.index]!
    repaired[best.index] = best.colorId
    usage.set(fromColorId, usage.get(fromColorId)! - 1)
    usage.set(best.colorId, (usage.get(best.colorId) ?? 0) + 1)
    edits.push({
      x: best.index % input.width,
      y: Math.floor(best.index / input.width),
      fromColorId,
      toColorId: best.colorId,
      reason: 'inventory',
    })
  }
  return { colorIds: repaired, edits, valid: true }
}
