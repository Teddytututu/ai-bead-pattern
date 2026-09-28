import { deltaE2000, type PreparedColor } from '../color.js'
import type { GridEditRecord, Lab } from '../types.js'

/** Bound damage from cleanup without changing protected features or contours. */
export function preserveFillEvidence(input: {
  width: number; activeMask: Uint8Array; excludedCells: ReadonlySet<number>
  sourceLabs: readonly Lab[]; referenceColorIds: readonly string[]; colorIds: readonly string[]
  colors: readonly PreparedColor[]; maximumAdditionalDeltaE?: number
}): { colorIds: readonly string[]; edits: readonly GridEditRecord[] } {
  const colors = new Map(input.colors.map(color => [color.id, color]))
  const edits: GridEditRecord[] = []
  const colorIds = input.colorIds.map((id, cell) => {
    const original = input.referenceColorIds[cell]!
    if (!input.activeMask[cell] || input.excludedCells.has(cell) || id === original) return id
    const difference = deltaE2000(input.sourceLabs[cell]!, colors.get(id)!.lab)
      - deltaE2000(input.sourceLabs[cell]!, colors.get(original)!.lab)
    // Nearby tones may form readable clusters; restore details when cleanup
    // adds more source error than the material policy allows.
    if (difference <= (input.maximumAdditionalDeltaE ?? 6)) return id
    edits.push({ x: cell % input.width, y: Math.floor(cell / input.width), fromColorId: id,
      toColorId: original, reason: 'fill-fidelity' })
    return original
  })
  return { colorIds, edits }
}
