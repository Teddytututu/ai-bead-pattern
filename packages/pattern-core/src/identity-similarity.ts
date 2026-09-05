import type { RGB } from './types.js'

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function luminance(rgb: RGB): number {
  return (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255
}

export function identityAppearanceSimilarity(
  source: readonly RGB[],
  candidate: readonly RGB[],
  activeMask: Uint8Array,
  width: number,
  height: number,
  importance?: Float32Array,
): number {
  const expected = width * height
  if (source.length !== expected || candidate.length !== expected || activeMask.length !== expected
    || (importance !== undefined && importance.length !== expected)) {
    throw new RangeError('Identity similarity buffers must align with the grid dimensions')
  }
  const sourceValues: number[] = []
  const candidateValues: number[] = []
  const weights: number[] = []
  for (let index = 0; index < expected; index += 1) {
    if (activeMask[index] !== 1) continue
    const weight = importance?.[index] ?? 1
    if (Number.isFinite(weight) === false || weight < 0) {
      throw new RangeError('Identity similarity importance values must be finite and non-negative')
    }
    if (weight === 0) continue
    sourceValues.push(luminance(source[index]!))
    candidateValues.push(luminance(candidate[index]!))
    weights.push(weight)
  }
  if (sourceValues.length === 0) return 0
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const sourceMean = sourceValues.reduce((sum, value, index) => sum + value * weights[index]!, 0) / totalWeight
  const candidateMean = candidateValues.reduce((sum, value, index) => sum + value * weights[index]!, 0) / totalWeight
  let covariance = 0
  let sourceVariance = 0
  let candidateVariance = 0
  let absoluteError = 0
  for (let index = 0; index < sourceValues.length; index += 1) {
    const weight = weights[index]!
    const sourceDelta = sourceValues[index]! - sourceMean
    const candidateDelta = candidateValues[index]! - candidateMean
    covariance += sourceDelta * candidateDelta * weight
    sourceVariance += sourceDelta * sourceDelta * weight
    candidateVariance += candidateDelta * candidateDelta * weight
    absoluteError += Math.abs(sourceValues[index]! - candidateValues[index]!) * weight
  }
  const correlation = sourceVariance <= 1e-8
    ? candidateVariance <= 1e-8 ? 1 : 0
    : candidateVariance <= 1e-8
      ? 0
      : clamp((covariance / Math.sqrt(sourceVariance * candidateVariance) + 1) / 2)
  const valueMatch = clamp(1 - absoluteError / totalWeight)
  return clamp(correlation * 0.8 + valueMatch * 0.2)
}
