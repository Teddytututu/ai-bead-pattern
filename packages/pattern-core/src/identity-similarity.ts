import { colorDistance, rgbToLab } from './color.js'
import type { RGB } from './types.js'

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function luminance(rgb: RGB): number {
  return (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255
}

function chromaMatch(source: RGB, candidate: RGB): number {
  // ΔE76 keeps this per-cell auxiliary metric inexpensive; the main palette
  // objective already uses ΔE2000 for final color assignment.
  const distance = colorDistance(rgbToLab(source), rgbToLab(candidate), 'delta-e-76')
  return clamp(1 - distance / 100)
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  const total = weights.reduce((sum, value) => sum + value, 0)
  return total <= 0
    ? 0
    : values.reduce((sum, value, index) => sum + value * weights[index]!, 0) / total
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
  const colorMatches: number[] = []
  const weights: number[] = []
  const activeIndices: number[] = []
  const positionByCell = new Int32Array(expected)
  positionByCell.fill(-1)
  for (let index = 0; index < expected; index += 1) {
    if (activeMask[index] !== 1) continue
    const weight = importance?.[index] ?? 1
    if (Number.isFinite(weight) === false || weight < 0) {
      throw new RangeError('Identity similarity importance values must be finite and non-negative')
    }
    if (weight === 0) continue
    sourceValues.push(luminance(source[index]!))
    candidateValues.push(luminance(candidate[index]!))
    colorMatches.push(chromaMatch(source[index]!, candidate[index]!))
    weights.push(weight)
    activeIndices.push(index)
    positionByCell[index] = activeIndices.length - 1
  }
  if (sourceValues.length === 0) return 0
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const sourceMean = weightedMean(sourceValues, weights)
  const candidateMean = weightedMean(candidateValues, weights)
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

  // A luminance-only correlation can rate a hue-swapped pattern as identical.
  // Lab colour agreement supplies an independent appearance signal, while the
  // local gradient term keeps salient boundaries spatially aligned.
  const colorMatch = weightedMean(colorMatches, weights)
  let edgeAgreementTotal = 0
  let edgeWeightTotal = 0
  const includeEdge = (first: number, second: number): void => {
    if (activeMask[first] !== 1 || activeMask[second] !== 1) return
    const firstPosition = positionByCell[first]!
    const secondPosition = positionByCell[second]!
    if (firstPosition < 0 || secondPosition < 0) return
    const sourceGradient = Math.abs(sourceValues[firstPosition]! - sourceValues[secondPosition]!)
    const candidateGradient = Math.abs(candidateValues[firstPosition]! - candidateValues[secondPosition]!)
    const pairWeight = Math.min(weights[firstPosition]!, weights[secondPosition]!)
    edgeAgreementTotal += (1 - Math.min(1, Math.abs(sourceGradient - candidateGradient))) * pairWeight
    edgeWeightTotal += pairWeight
  }
  for (const index of activeIndices) {
    const x = index % width
    const y = Math.floor(index / width)
    if (x + 1 < width) includeEdge(index, index + 1)
    if (y + 1 < height) includeEdge(index, index + width)
  }
  const edgeAgreement = edgeWeightTotal <= 0 ? valueMatch : edgeAgreementTotal / edgeWeightTotal
  return clamp(correlation * 0.62 + colorMatch * 0.23 + edgeAgreement * 0.15)
}
