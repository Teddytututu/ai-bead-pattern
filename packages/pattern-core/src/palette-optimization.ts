import { colorDistance, type PreparedColor } from './color.js'
import type { ColorDistanceMethod, Lab } from './types.js'

export interface PaletteOptimizationResult {
  colorIds: readonly string[]
  changedCells: number
}

interface PaletteOptimizationInput {
  pixelLabs: readonly Lab[]
  initialColorIds: readonly string[]
  colors: readonly PreparedColor[]
  width: number
  height: number
  activeMask: Uint8Array
  importance: readonly number[]
  protectedCells: ReadonlySet<number>
  coherence: number
  edgeProtection: number
  iterations: number
  distanceMethod: ColorDistanceMethod
}

const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function optimizePaletteAssignments(input: PaletteOptimizationInput): PaletteOptimizationResult {
  if (input.coherence <= 0 || input.iterations <= 0) {
    return { colorIds: [...input.initialColorIds], changedCells: 0 }
  }
  const colorIds = [...input.initialColorIds]
  const colorsById = new Map(input.colors.map((color) => [color.id, color]))
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    let iterationChanges = 0
    for (let y = 0; y < input.height; y += 1) {
      for (let x = 0; x < input.width; x += 1) {
        const index = y * input.width + x
        if (input.activeMask[index] !== 1) continue
        const protectedCell = input.protectedCells.has(index)
        let bestId = colorIds[index]!
        let bestEnergy = Number.POSITIVE_INFINITY
        for (const candidate of input.colors) {
          const dataWeight = (0.75 + (input.importance[index] ?? 1) * 0.55)
            * (protectedCell ? 2.5 : 1)
          let energy = colorDistance(
            input.pixelLabs[index]!,
            candidate.lab,
            input.distanceMethod,
          ) * dataWeight
          for (const [offsetX, offsetY] of offsets) {
            const nextX = x + offsetX
            const nextY = y + offsetY
            if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
            const next = nextY * input.width + nextX
            if (input.activeMask[next] !== 1 || colorIds[next] === candidate.id) continue
            const sourceBoundary = clamp(colorDistance(
              input.pixelLabs[index]!,
              input.pixelLabs[next]!,
              'delta-e-76',
            ) / 60, 0, 1)
            const boundaryAllowance = 1 - sourceBoundary * clamp(input.edgeProtection, 0, 1)
            energy += input.coherence * 16 * boundaryAllowance * (protectedCell ? 0.15 : 1)
          }
          const currentBest = colorsById.get(bestId)
          if (energy < bestEnergy
            || (energy === bestEnergy && candidate.id.localeCompare(currentBest?.id ?? bestId) < 0)) {
            bestEnergy = energy
            bestId = candidate.id
          }
        }
        if (bestId !== colorIds[index]) {
          colorIds[index] = bestId
          iterationChanges += 1
        }
      }
    }
    if (iterationChanges === 0) break
  }
  let changedCells = 0
  for (let index = 0; index < colorIds.length; index += 1) {
    if (colorIds[index] !== input.initialColorIds[index]) changedCells += 1
  }
  return { colorIds, changedCells }
}
