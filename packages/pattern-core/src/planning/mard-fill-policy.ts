import { deltaE2000, prepareColors, rgbToLab } from '../color.js'
import type { Lab, MaterialColor } from '../types.js'
export { preserveFillEvidence } from './fill-fidelity.js'

/** Product constraints on the existing MARD catalog, not synthesized RGB colors. */
export const mardFillPolicyVersion = 'mard-single-ink-source-fill-v2'
export function isBlackFill(color: MaterialColor): boolean {
  // MARD's nominal black H7 is #010101, not exactly #000000.
  return color.id === 'H7' || Math.max(...color.rgb) <= 8
}
export function isDeepSaturatedInk(color: MaterialColor): boolean {
  const maximum = Math.max(...color.rgb), minimum = Math.min(...color.rgb)
  // Perceptual lightness keeps saturated blue/violet inks that HSV value rejects.
  return maximum > 0 && (maximum - minimum) / maximum >= 0.5 && rgbToLab(color.rgb)[0] <= 32
}

export function selectSingleInk(input: {
  colors: readonly MaterialColor[]; pixelLabs: readonly Lab[]; referenceMask: Uint8Array
  contourCells: readonly number[]; colorId?: string; inventory?: Readonly<Record<string, number>>
}): string {
  const candidates = prepareColors(input.colors).filter(color => isDeepSaturatedInk(color)
    && (input.inventory?.[color.id] ?? Infinity) >= input.contourCells.length)
  if (input.colorId !== undefined) {
    if (!candidates.some(color => color.id === input.colorId)) throw new RangeError('MARD contour color must be a stocked deep saturated ink with enough beads for the entire contour')
    return input.colorId
  }
  if (!candidates.length) throw new RangeError('No MARD deep saturated ink can cover the entire contour')
  // One global, chroma-weighted source hue; the subject mask excludes the background.
  let a = 0, b = 0, total = 0
  input.pixelLabs.forEach((lab, cell) => {
    if (!input.referenceMask[cell]) return
    const weight = Math.max(1, Math.hypot(lab[1], lab[2]))
    a += lab[1] * weight; b += lab[2] * weight; total += weight
  })
  a /= Math.max(1, total); b /= Math.max(1, total)
  const chroma = Math.hypot(a, b), scale = chroma > 1 ? Math.max(1, 24 / chroma) : 1
  const target: Lab = [18, a * scale, b * scale]
  return [...candidates].sort((first, second) => deltaE2000(target, first.lab) - deltaE2000(target, second.lab)
    || first.id.localeCompare(second.id))[0]!.id
}
