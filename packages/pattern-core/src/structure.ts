import type {
  BinaryMask,
  ImageAnalysis,
  PixelImage,
  RGB,
} from './types.js'
import { resolvedSubjectMask, subjectMaskConfidence } from './analysis-evidence.js'
import { landmarkEffectiveConfidence, landmarkSourceRadiusPx } from './landmarks.js'

export interface SourceGuidance {
  width: number
  height: number
  importance: Float32Array
  edge: Float32Array
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function sourceRgb(image: PixelImage, index: number, background: RGB): RGB {
  const offset = index * 4
  const alpha = (image.data[offset + 3] ?? 255) / 255
  return [0, 1, 2].map((channel) => Math.round(
    (image.data[offset + channel] ?? 0) * alpha + background[channel]! * (1 - alpha),
  )) as unknown as RGB
}

function luminance(rgb: RGB): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

function maskValue(mask: BinaryMask | undefined, index: number): number {
  return clamp(mask?.values[index] ?? 0, 0, 1)
}

export function buildSourceGuidance(
  image: PixelImage,
  analysis: ImageAnalysis | undefined,
  background: RGB = [255, 255, 255],
): SourceGuidance {
  const total = image.width * image.height
  const lightness = new Float32Array(total)
  const edge = new Float32Array(total)
  const importance = new Float32Array(total)
  const subjectMask = resolvedSubjectMask(analysis)
  const maskConfidence = subjectMaskConfidence(analysis)
  for (let index = 0; index < total; index += 1) {
    lightness[index] = luminance(sourceRgb(image, index, background))
  }
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x
      const left = lightness[y * image.width + Math.max(0, x - 1)]!
      const right = lightness[y * image.width + Math.min(image.width - 1, x + 1)]!
      const top = lightness[Math.max(0, y - 1) * image.width + x]!
      const bottom = lightness[Math.min(image.height - 1, y + 1) * image.width + x]!
      edge[index] = clamp(Math.hypot(right - left, bottom - top) / 255, 0, 1)
    }
  }
  for (let index = 0; index < total; index += 1) {
    importance[index] = Math.max(
      importance[index]!,
      clamp(analysis?.importanceMap?.weights[index] ?? 0, 0, 1),
      maskValue(subjectMask, index) * 0.55 * maskConfidence,
    )
  }
  for (const region of analysis?.semanticRegions ?? []) {
    const regionWeight = clamp(
      (region.importance ?? 0.45) * region.confidence,
      0,
      1,
    )
    for (let index = 0; index < total; index += 1) {
      importance[index] = Math.max(
        importance[index]!,
        maskValue(region.mask, index) * regionWeight,
      )
    }
  }
  for (const landmark of analysis?.landmarks ?? []) {
    const confidence = landmarkEffectiveConfidence(landmark)
    if (confidence <= 0) continue
    const radius = Math.max(0, Math.ceil(landmarkSourceRadiusPx(landmark)))
    const centerX = Math.round(landmark.x)
    const centerY = Math.round(landmark.y)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const x = centerX + offsetX
        const y = centerY + offsetY
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
        const distance = Math.hypot(offsetX, offsetY)
        const falloff = radius === 0 ? 1 : Math.max(0, 1 - distance / (radius + 1))
        const priority = landmark.priority === 'hard' ? 1 : 0.75
        const index = y * image.width + x
        importance[index] = Math.max(
          importance[index]!,
          priority * confidence * falloff,
        )
      }
    }
  }
  return { width: image.width, height: image.height, importance, edge }
}

function hueBucket(rgb: RGB): string {
  const maximum = Math.max(...rgb)
  const minimum = Math.min(...rgb)
  const chroma = maximum - minimum
  if (chroma < 22) return 'neutral'
  let hue = 0
  if (maximum === rgb[0]) hue = ((rgb[1] - rgb[2]) / chroma + 6) % 6
  else if (maximum === rgb[1]) hue = (rgb[2] - rgb[0]) / chroma + 2
  else hue = (rgb[0] - rgb[1]) / chroma + 4
  return `hue-${Math.floor(hue)}`
}

function quantile(values: readonly number[], fraction: number): number {
  const index = clamp(Math.round((values.length - 1) * fraction), 0, values.length - 1)
  return values[index]!
}

export function designRegionValues(
  pixels: readonly RGB[],
  activeMask: Uint8Array,
  levels: 2 | 3 | 4,
  importance: readonly number[],
  regionIds?: readonly (string | undefined)[],
): readonly RGB[] {
  const groups = new Map<string, number[]>()
  for (let index = 0; index < pixels.length; index += 1) {
    if (activeMask[index] !== 1) continue
    const group = regionIds?.[index] ?? hueBucket(pixels[index]!)
    const entries = groups.get(group) ?? []
    entries.push(index)
    groups.set(group, entries)
  }
  const output = [...pixels]
  for (const indices of groups.values()) {
    if (indices.length < levels) continue
    const values = indices.map((index) => luminance(pixels[index]!)).sort((a, b) => a - b)
    const targets = Array.from({ length: levels }, (_value, level) =>
      quantile(values, level / (levels - 1)),
    )
    for (const index of indices) {
      if ((importance[index] ?? 0) >= 2.5) continue
      const pixel = pixels[index]!
      const current = luminance(pixel)
      const target = targets.reduce((best, candidate) =>
        Math.abs(candidate - current) < Math.abs(best - current) ? candidate : best,
      )
      const delta = target - current
      output[index] = [
        clamp(Math.round(pixel[0] + delta), 0, 255),
        clamp(Math.round(pixel[1] + delta), 0, 255),
        clamp(Math.round(pixel[2] + delta), 0, 255),
      ]
    }
  }
  return output
}
