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
  /** Optional hard locks and per-cell palette restrictions used by global repair. */
  lockedColorIdsByCell?: readonly (string | undefined)[]
  allowedColorIdsByCell?: readonly (ReadonlySet<string> | undefined)[]
  initialColorIds?: readonly (string | undefined)[]
  editPenalty?: number
  substituteColorIds?: Readonly<Record<string, readonly string[]>>
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
  substituteColorIds?: Readonly<Record<string, readonly string[]>>
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
  if (input.lockedColorIdsByCell !== undefined && input.lockedColorIdsByCell.length !== input.pixels.length) {
    throw new RangeError('Palette locks must align with the image grid')
  }
  if (input.allowedColorIdsByCell !== undefined && input.allowedColorIdsByCell.length !== input.pixels.length) {
    throw new RangeError('Palette cell colour restrictions must align with the image grid')
  }
  if (input.initialColorIds !== undefined && input.initialColorIds.length !== input.pixels.length) {
    throw new RangeError('Palette initial assignments must align with the image grid')
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
  const base = input.baseline === 'a0'
    ? Math.sqrt(
      (input.pixels[pixelIndex]![0] - color.rgb[0]) ** 2
      + (input.pixels[pixelIndex]![1] - color.rgb[1]) ** 2
      + (input.pixels[pixelIndex]![2] - color.rgb[2]) ** 2,
    )
    : colorDistance(input.pixelLabs[pixelIndex]!, color.lab, input.distanceMethod)
  const initial = input.initialColorIds?.[pixelIndex]
  const changed = input.editPenalty !== undefined && initial !== undefined && initial !== color.id
  const substitute = initial !== undefined && input.substituteColorIds?.[initial]?.includes(color.id) === true
  return base + (changed ? input.editPenalty! * Math.max(0.05, input.weights[pixelIndex] ?? 1) : 0)
    - (substitute && input.editPenalty !== undefined ? input.editPenalty * 0.25 : 0)
}

type DistanceMatrix = readonly Float32Array[]

export type PaletteDistanceMatrixCache = Map<string, DistanceMatrix>

function matrixCacheKey(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
): string {
  // Hash IEEE-754 values directly.  Quantising the key to three decimals
  // merged visibly different Lab samples and made cache reuse data-dependent.
  // FNV-1a over the raw bytes keeps the key compact while preserving inputs.
  let hash = 0x811c9dc5
  let hash2 = 0x9e3779b9
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  const add = (value: number): void => {
    view.setFloat64(0, Number.isFinite(value) ? value : 0, true)
    for (const byte of bytes) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193)
      hash2 ^= byte + 0x9e3779b9
      hash2 = Math.imul(hash2, 0x85ebca6b)
    }
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
  return `${input.baseline}:${input.distanceMethod}:${input.pixelLabs.length}:${hash >>> 0}:${hash2 >>> 0}`
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
  const colorIndexById = new Map(colors.map((color, index) => [color.id, index]))
  const nearest = new Float64Array(input.pixelLabs.length)
  nearest.fill(Number.POSITIVE_INFINITY)
  for (let index = 0; index < nearest.length; index += 1) {
    if (input.activeMask?.[index] === 0) continue
    for (const colorId of selected) {
      const colorIndex = colorIndexById.get(colorId)
      if (colorIndex !== undefined) nearest[index] = Math.min(nearest[index]!, matrixDistance(matrix, colorIndex, index))
    }
  }
  while (selected.size < limit) {
    let best: { color: PreparedColor; cost: number } | undefined
    for (const color of selectable) {
      if (selected.has(color.id)) continue
      if (canCoverDemand(color) === false) continue
      const colorIndex = colorIndexById.get(color.id)!
      let cost = 0
      for (let index = 0; index < input.pixelLabs.length; index += 1) {
        if (input.activeMask?.[index] === 0) continue
        const candidateDistance = matrixDistance(matrix, colorIndex, index)
        cost += Math.min(nearest[index]!, candidateDistance) * (input.weights[index] ?? 1)
      }
      if (best === undefined || cost < best.cost
        || (cost === best.cost && color.id.localeCompare(best.color.id) < 0)) {
        best = { color, cost }
      }
    }
    if (best === undefined) break
    selected.add(best.color.id)
    const bestIndex = colorIndexById.get(best.color.id)!
    for (let index = 0; index < nearest.length; index += 1) {
      if (input.activeMask?.[index] === 0) continue
      nearest[index] = Math.min(nearest[index]!, matrixDistance(matrix, bestIndex, index))
    }
  }
  return colors.filter((color) => selected.has(color.id))
}

function candidateOrder(
  input: PaletteQuantizationInput,
  pixelIndex: number,
  colors: readonly PreparedColor[],
  matrix: DistanceMatrix,
  remaining: Readonly<Record<string, number>>,
): readonly PreparedColor[] {
  const colorIndexById = new Map(colors.map((color, index) => [color.id, index]))
  const allowed = input.allowedColorIdsByCell?.[pixelIndex]
  const locked = input.lockedColorIdsByCell?.[pixelIndex]
  const ranked = colors
    .filter((color) => (remaining[color.id] ?? Number.POSITIVE_INFINITY) > 0
      && (locked === undefined || color.id === locked)
      && (allowed === undefined || allowed.has(color.id)))
    .map((color) => ({ color, cost: matrixDistance(matrix, colorIndexById.get(color.id)!, pixelIndex) }))
    .sort((first, second) => first.cost - second.cost || first.color.id.localeCompare(second.color.id))
  if (ranked.length === 0) return []
  return ranked.map((entry) => entry.color)
}

interface FlowItem { delta: number; index: number }

class MinHeap {
  private readonly values: FlowItem[] = []
  push(value: FlowItem): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.values[parent]!, value) <= 0) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }
  peek(): FlowItem | undefined { return this.values[0] }
  pop(): FlowItem | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (last !== undefined && this.values.length > 0) {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        if (left >= this.values.length) break
        const right = left + 1
        const child = right < this.values.length
          && this.compare(this.values[right]!, this.values[left]!) < 0 ? right : left
        if (this.compare(this.values[child]!, last) >= 0) break
        this.values[index] = this.values[child]!
        index = child
      }
      this.values[index] = last
    }
    return first
  }
  private compare(first: FlowItem, second: FlowItem): number {
    return first.delta - second.delta || first.index - second.index
  }
}

/**
 * Solves the finite-stock colour assignment as a transportation problem.
 * Starting from independent nearest colours, each augmentation moves one bead
 * along the cheapest residual colour path.  The residual graph allows chains
 * such as A -> B -> C, which greedy overflow repair cannot discover.
 */
function assignColorsGlobally(
  input: PaletteQuantizationInput,
  colors: readonly PreparedColor[],
  matrix: DistanceMatrix,
): readonly string[] {
  const remaining: Record<string, number> = Object.fromEntries(
    colors.map((color) => [color.id, stock(input.inventory, color.id)]),
  )
  const colorIds = new Array<string>(input.pixels.length)
  const colorIndexById = new Map(colors.map((color, index) => [color.id, index]))
  const active = Array.from({ length: input.pixels.length }, (_value, index) => index)
    .filter((index) => input.activeMask?.[index] !== 0)
  for (const index of active) {
    const candidate = candidateOrder(input, index, colors, matrix, remaining)[0]
    if (candidate === undefined) throw new RangeError('Palette inventory cannot cover all active cells')
    colorIds[index] = candidate.id
    remaining[candidate.id] = remaining[candidate.id]! - 1
  }
  const finite = colors.some((color) => Number.isFinite(stock(input.inventory, color.id)))
  if (finite) {
    const count = new Int32Array(colors.length)
    for (const index of active) {
      const colorIndex = colorIndexById.get(colorIds[index]!)
      if (colorIndex === undefined) throw new RangeError('Palette assignment references an unknown color')
      count[colorIndex] = (count[colorIndex] ?? 0) + 1
    }
    const capacity = colors.map((color) => Number.isFinite(stock(input.inventory, color.id))
      ? stock(input.inventory, color.id) : active.length)
    const heaps = Array.from({ length: colors.length * colors.length }, () => new MinHeap())
    const pushAlternatives = (index: number, from: number): void => {
      if (input.lockedColorIdsByCell?.[index] !== undefined) return
      const allowed = input.allowedColorIdsByCell?.[index]
      for (let to = 0; to < colors.length; to += 1) {
        if (to === from || (allowed !== undefined && !allowed.has(colors[to]!.id))) continue
        const delta = (matrix[to]![index]! - matrix[from]![index]!)
          * Math.max(0, input.weights[index] ?? 1)
        heaps[from * colors.length + to]!.push({ delta, index })
      }
    }
    for (const index of active) pushAlternatives(index, colorIndexById.get(colorIds[index]!)!)
    const validEdge = (from: number, to: number): FlowItem | undefined => {
      const heap = heaps[from * colors.length + to]!
      while (heap.peek() !== undefined) {
        const item = heap.peek()!
        if (colorIndexById.get(colorIds[item.index]!) === from) return item
        heap.pop()
      }
      return undefined
    }
    const move = (from: number, to: number): void => {
      const item = validEdge(from, to)
      if (item === undefined) throw new RangeError('Palette residual assignment became infeasible')
      colorIds[item.index] = colors[to]!.id
      count[from] = (count[from] ?? 0) - 1
      count[to] = (count[to] ?? 0) + 1
      heaps[from * colors.length + to]!.pop()
      pushAlternatives(item.index, to)
    }
    while (true) {
      const excess = colors.map((_color, index) => count[index]! - capacity[index]!)
      const deficits = colors.map((_color, index) => capacity[index]! - count[index]!)
      const source = excess.findIndex((value) => value > 0)
      if (source < 0) break
      const distances = new Float64Array(colors.length)
      distances.fill(Number.POSITIVE_INFINITY)
      const previous = new Int32Array(colors.length)
      previous.fill(-1)
      distances[source] = 0
      for (let round = 0; round < colors.length - 1; round += 1) {
        let changed = false
        for (let from = 0; from < colors.length; from += 1) {
          if (!Number.isFinite(distances[from])) continue
          for (let to = 0; to < colors.length; to += 1) {
            if (to === from || to === source) continue
            const edge = validEdge(from, to)
            if (edge === undefined) continue
            const candidate = distances[from]! + edge.delta
            if (candidate < distances[to]! - 1e-10) {
              distances[to] = candidate
              previous[to] = from
              changed = true
            }
          }
        }
        if (!changed) break
      }
      let target = -1
      for (let index = 0; index < colors.length; index += 1) {
        if ((deficits[index] ?? 0) <= 0 || !Number.isFinite(distances[index])) continue
        if (target < 0 || distances[index]! < distances[target]! - 1e-10
          || (Math.abs(distances[index]! - distances[target]!) <= 1e-10
            && colors[index]!.id.localeCompare(colors[target]!.id) < 0)) target = index
      }
      if (target < 0) throw new RangeError('Palette inventory cannot cover all active cells')
      const path: number[] = []
      for (let node = target; node !== source; node = previous[node]!) {
        const predecessor = previous[node]
        if (node < 0 || predecessor === undefined || predecessor < 0) {
          throw new RangeError('Palette residual assignment became infeasible')
        }
        path.push(node)
      }
      path.push(source)
      path.reverse()
      for (let index = 0; index + 1 < path.length; index += 1) move(path[index]!, path[index + 1]!)
    }
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
  return { selectedColors, colorIds: assignColorsGlobally(input, selectedColors, selectedMatrix) }
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
  const usage = new Map<string, number>()
  for (let index = 0; index < input.colorIds.length; index += 1) {
    if (input.activeMask[index] !== 1) continue
    const colorId = input.colorIds[index]!
    usage.set(colorId, (usage.get(colorId) ?? 0) + 1)
  }
  const over = [...usage].some(([colorId, count]) =>
    Number.isFinite(input.inventory![colorId]) && count > input.inventory![colorId]!)
  if (!over) return { colorIds: [...input.colorIds], edits: [], valid: true }

  // Solve the complete constrained assignment in one pass.  Existing protected
  // cells become hard locks; editPenalty keeps the repair local while allowing
  // a cheaper multi-colour reassignment chain when a donor colour is saturated.
  const pixels = input.pixelLabs.map((): [number, number, number] => [0, 0, 0])
  const lockedColorIdsByCell = input.colorIds.map((colorId, index) =>
    input.protectedCells.has(index) ? colorId : undefined)
  let repaired: PaletteQuantizationResult
  try {
    repaired = quantizePalette({
      pixels,
      pixelLabs: input.pixelLabs,
      weights: input.importance,
      colors: input.colors.map((color) => ({ ...color, lab: color.lab! })),
      maximumColors: input.colors.length,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      activeMask: input.activeMask,
      inventory: input.inventory,
      lockedColorIdsByCell,
      initialColorIds: input.colorIds,
      editPenalty: 64,
      ...(input.substituteColorIds === undefined ? {} : { substituteColorIds: input.substituteColorIds }),
    })
  } catch (_error) {
    return { colorIds: [...input.colorIds], edits: [], valid: false }
  }
  const edits: GridEditRecord[] = []
  for (let index = 0; index < repaired.colorIds.length; index += 1) {
    if (input.activeMask[index] !== 1 || repaired.colorIds[index] === input.colorIds[index]) continue
    edits.push({
      x: index % input.width,
      y: Math.floor(index / input.width),
      fromColorId: input.colorIds[index]!,
      toColorId: repaired.colorIds[index]!,
      reason: 'inventory',
    })
  }
  const repairedUsage = new Map<string, number>()
  for (let index = 0; index < repaired.colorIds.length; index += 1) {
    if (input.activeMask[index] !== 1) continue
    const colorId = repaired.colorIds[index]!
    repairedUsage.set(colorId, (repairedUsage.get(colorId) ?? 0) + 1)
  }
  const valid = [...repairedUsage].every(([colorId, count]) =>
    !Number.isFinite(input.inventory![colorId]) || count <= input.inventory![colorId]!)
  return { colorIds: repaired.colorIds, edits, valid }
}
