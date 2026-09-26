import { deltaE2000 } from '../color.js'
import type { Lab } from '../types.js'

export interface ColorStageError {
  cells: number
  meanDeltaE: number
  medianDeltaE: number
  p95DeltaE: number
  meanSignedLightnessShift: number
  meanAbsoluteLightnessShift: number
  meanAbsoluteChromaShift: number
}

/** All stages compare against the same sampled source; distances are not additive. */
export function colorStageError(source: readonly Lab[], target: readonly Lab[], active: Uint8Array): ColorStageError {
  const errors: number[] = []
  let signedLightness = 0, absoluteLightness = 0, chroma = 0
  for (let cell = 0; cell < active.length; cell++) {
    if (active[cell] !== 1) continue
    const from = source[cell]!, to = target[cell]!
    errors.push(deltaE2000(from, to))
    signedLightness += to[0] - from[0]
    absoluteLightness += Math.abs(to[0] - from[0])
    chroma += Math.abs(Math.hypot(to[1], to[2]) - Math.hypot(from[1], from[2]))
  }
  errors.sort((a, b) => a - b)
  const count = Math.max(1, errors.length)
  const percentile = (fraction: number): number => {
    if (!errors.length) return 0
    const position = (errors.length - 1) * fraction, lower = Math.floor(position)
    return errors[lower]! + (errors[Math.ceil(position)]! - errors[lower]!) * (position - lower)
  }
  return { cells: errors.length, meanDeltaE: errors.reduce((sum, error) => sum + error, 0) / count,
    medianDeltaE: percentile(0.5), p95DeltaE: percentile(0.95), meanSignedLightnessShift: signedLightness / count,
    meanAbsoluteLightnessShift: absoluteLightness / count, meanAbsoluteChromaShift: chroma / count }
}

export interface ColorFidelityDiagnostics {
  /** Geometry changes are included in this stage and are not attributed to tone changes. */
  structure: ColorStageError
  value: ColorStageError
  quantization: ColorStageError
  final: ColorStageError
  /** Unconstrained nearest reference within the SAME selected palette, before features/cleanup. */
  selectedPaletteNearestMeanDeltaE: number
  colorPlanningActive: boolean
}
