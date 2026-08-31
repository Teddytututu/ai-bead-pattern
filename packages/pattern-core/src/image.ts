import type { SourceGuidance } from './structure.js'
import type { CropRect, PatternStyle, PixelImage, ResizeMethod, RGB } from './types.js'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeCrop(image: PixelImage, crop?: CropRect): CropRect {
  if (crop === undefined) {
    return { x: 0, y: 0, width: image.width, height: image.height }
  }
  const x = clamp(Math.floor(crop.x), 0, image.width - 1)
  const y = clamp(Math.floor(crop.y), 0, image.height - 1)
  return {
    x,
    y,
    width: clamp(Math.floor(crop.width), 1, image.width - x),
    height: clamp(Math.floor(crop.height), 1, image.height - y),
  }
}

function pixelAt(image: PixelImage, x: number, y: number, backgroundRgb: RGB): RGB {
  const safeX = clamp(x, 0, image.width - 1)
  const safeY = clamp(y, 0, image.height - 1)
  const index = (safeY * image.width + safeX) * 4
  const alpha = (image.data[index + 3] ?? 255) / 255
  return [0, 1, 2].map((channel) => Math.round(
    (image.data[index + channel] ?? 0) * alpha + backgroundRgb[channel]! * (1 - alpha),
  )) as unknown as RGB
}

function alphaAt(image: PixelImage, x: number, y: number): number {
  const safeX = clamp(x, 0, image.width - 1)
  const safeY = clamp(y, 0, image.height - 1)
  return (image.data[(safeY * image.width + safeX) * 4 + 3] ?? 255) / 255
}

function nearestSample(image: PixelImage, sourceX: number, sourceY: number, backgroundRgb: RGB): RGB {
  return pixelAt(image, Math.round(sourceX), Math.round(sourceY), backgroundRgb)
}

function bilinearSample(image: PixelImage, sourceX: number, sourceY: number, backgroundRgb: RGB): RGB {
  const x0 = Math.floor(sourceX)
  const y0 = Math.floor(sourceY)
  const tx = sourceX - x0
  const ty = sourceY - y0
  const topLeft = pixelAt(image, x0, y0, backgroundRgb)
  const topRight = pixelAt(image, x0 + 1, y0, backgroundRgb)
  const bottomLeft = pixelAt(image, x0, y0 + 1, backgroundRgb)
  const bottomRight = pixelAt(image, x0 + 1, y0 + 1, backgroundRgb)
  return [0, 1, 2].map((channel) => Math.round(
    topLeft[channel]! * (1 - tx) * (1 - ty)
      + topRight[channel]! * tx * (1 - ty)
      + bottomLeft[channel]! * (1 - tx) * ty
      + bottomRight[channel]! * tx * ty,
  )) as unknown as RGB
}

function areaSample(
  image: PixelImage,
  sourceLeft: number,
  sourceTop: number,
  sourceRight: number,
  sourceBottom: number,
  backgroundRgb: RGB,
): RGB {
  const totals: [number, number, number] = [0, 0, 0]
  let totalWeight = 0
  for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
    const overlapY = Math.max(0, Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY))
    for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
      const overlapX = Math.max(0, Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX))
      const weight = overlapX * overlapY
      const pixel = pixelAt(image, sourceX, sourceY, backgroundRgb)
      totals[0] += pixel[0] * weight
      totals[1] += pixel[1] * weight
      totals[2] += pixel[2] * weight
      totalWeight += weight
    }
  }
  return [
    Math.round(totals[0]! / totalWeight),
    Math.round(totals[1]! / totalWeight),
    Math.round(totals[2]! / totalWeight),
  ]
}

export interface SamplingGuidance {
  source: SourceGuidance
  importanceStrength: number
  edgeStrength: number
  preserveThinStructures?: boolean
}

function guidedAreaSample(
  image: PixelImage,
  sourceLeft: number,
  sourceTop: number,
  sourceRight: number,
  sourceBottom: number,
  backgroundRgb: RGB,
  guidance: SamplingGuidance,
): RGB {
  const totals: [number, number, number] = [0, 0, 0]
  let totalWeight = 0
  let importanceTotal = 0
  let sampleCount = 0
  let peakScore = -1
  let peakImportance = 0
  let peakPixel: RGB | undefined
  let peakForegroundScore = -1
  let peakForegroundAlpha = 0
  let peakForegroundPixel: RGB | undefined
  for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
    const overlapY = Math.max(0, Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY))
    for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
      const overlapX = Math.max(0, Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX))
      const overlap = overlapX * overlapY
      const safeX = clamp(sourceX, 0, image.width - 1)
      const safeY = clamp(sourceY, 0, image.height - 1)
      const index = safeY * image.width + safeX
      const importance = guidance.source.importance[index] ?? 0
      const edge = guidance.source.edge[index] ?? 0
      const score = importance * guidance.importanceStrength + edge * guidance.edgeStrength
      const weight = overlap * (1 + score)
      const pixel = pixelAt(image, sourceX, sourceY, backgroundRgb)
      totals[0] += pixel[0] * weight
      totals[1] += pixel[1] * weight
      totals[2] += pixel[2] * weight
      totalWeight += weight
      importanceTotal += importance
      sampleCount += 1
      if (score > peakScore) {
        peakScore = score
        peakImportance = importance
        peakPixel = pixel
      }
      if (guidance.preserveThinStructures === true) {
        const alpha = alphaAt(image, sourceX, sourceY)
        const contrast = Math.hypot(
          pixel[0] - backgroundRgb[0],
          pixel[1] - backgroundRgb[1],
          pixel[2] - backgroundRgb[2],
        )
        const foregroundScore = alpha * (contrast + score * 64)
        if (foregroundScore > peakForegroundScore) {
          peakForegroundScore = foregroundScore
          peakForegroundAlpha = alpha
          peakForegroundPixel = pixel
        }
      }
    }
  }
  if (peakForegroundPixel !== undefined && peakForegroundAlpha >= 0.2
    && peakForegroundScore >= 12) {
    return peakForegroundPixel
  }
  const averageImportance = importanceTotal / Math.max(1, sampleCount)
  if (peakPixel !== undefined && peakImportance >= 0.85 && peakImportance - averageImportance >= 0.25) {
    return peakPixel
  }
  return [
    Math.round(totals[0]! / totalWeight),
    Math.round(totals[1]! / totalWeight),
    Math.round(totals[2]! / totalWeight),
  ]
}

export interface CanvasFit {
  x: number
  y: number
  width: number
  height: number
}

export interface ResizedPixels {
  pixels: readonly RGB[]
  activeMask: Uint8Array
  fit: CanvasFit
}

export function fitCropToCanvas(crop: CropRect, width: number, height: number): CanvasFit {
  const scale = Math.min(width / crop.width, height / crop.height)
  const fittedWidth = clamp(Math.round(crop.width * scale), 1, width)
  const fittedHeight = clamp(Math.round(crop.height * scale), 1, height)
  return {
    x: Math.floor((width - fittedWidth) / 2),
    y: Math.floor((height - fittedHeight) / 2),
    width: fittedWidth,
    height: fittedHeight,
  }
}

export function sourcePointForGridCell(
  crop: CropRect,
  fit: CanvasFit,
  x: number,
  y: number,
): readonly [sourceX: number, sourceY: number] | undefined {
  if (x < fit.x || y < fit.y || x >= fit.x + fit.width || y >= fit.y + fit.height) {
    return undefined
  }
  return [
    crop.x + (x - fit.x + 0.5) * crop.width / fit.width - 0.5,
    crop.y + (y - fit.y + 0.5) * crop.height / fit.height - 0.5,
  ]
}

export function gridCellForSourcePoint(
  crop: CropRect,
  fit: CanvasFit,
  sourceX: number,
  sourceY: number,
): readonly [gridX: number, gridY: number] {
  return [
    clamp(fit.x + Math.floor((sourceX - crop.x) / crop.width * fit.width), fit.x, fit.x + fit.width - 1),
    clamp(fit.y + Math.floor((sourceY - crop.y) / crop.height * fit.height), fit.y, fit.y + fit.height - 1),
  ]
}

export function resizePixels(
  image: PixelImage,
  crop: CropRect,
  width: number,
  height: number,
  method: ResizeMethod,
  backgroundRgb: RGB = [255, 255, 255],
  guidance?: SamplingGuidance,
): ResizedPixels {
  const pixels: RGB[] = []
  const activeMask = new Uint8Array(width * height)
  const fit = fitCropToCanvas(crop, width, height)
  const scaleX = crop.width / fit.width
  const scaleY = crop.height / fit.height
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const sourcePoint = sourcePointForGridCell(crop, fit, x, y)
      if (sourcePoint === undefined) {
        pixels.push(backgroundRgb)
        continue
      }
      activeMask[index] = 1
      const localX = x - fit.x
      const localY = y - fit.y
      if (method === 'nearest') {
        pixels.push(nearestSample(
          image,
          sourcePoint[0],
          sourcePoint[1],
          backgroundRgb,
        ))
      } else if (method === 'bilinear' || scaleX < 1 || scaleY < 1) {
        pixels.push(bilinearSample(
          image,
          sourcePoint[0],
          sourcePoint[1],
          backgroundRgb,
        ))
      } else {
        const sourceLeft = clamp(crop.x + localX * scaleX, crop.x, crop.x + crop.width)
        const sourceTop = clamp(crop.y + localY * scaleY, crop.y, crop.y + crop.height)
        const sourceRight = clamp(crop.x + (localX + 1) * scaleX, crop.x, crop.x + crop.width)
        const sourceBottom = clamp(crop.y + (localY + 1) * scaleY, crop.y, crop.y + crop.height)
        pixels.push(guidance === undefined
          ? areaSample(image, sourceLeft, sourceTop, sourceRight, sourceBottom, backgroundRgb)
          : guidedAreaSample(
            image,
            sourceLeft,
            sourceTop,
            sourceRight,
            sourceBottom,
            backgroundRgb,
            guidance,
          ))
      }
    }
  }
  return { pixels, activeMask, fit }
}

export function samplePixelsAtSourceMapping(
  inputPixels: readonly RGB[],
  width: number,
  height: number,
  sourceMapping: Float32Array,
  activeMask: Uint8Array,
  crop: CropRect,
  fit: CanvasFit,
  backgroundRgb: RGB = [255, 255, 255],
): readonly RGB[] {
  if (inputPixels.length !== width * height || activeMask.length !== width * height
    || sourceMapping.length !== activeMask.length * 2) {
    throw new RangeError('Source mapping must contain two coordinates per target cell')
  }
  const gridPixel = (x: number, y: number): RGB => {
    const safeX = clamp(x, 0, width - 1)
    const safeY = clamp(y, 0, height - 1)
    const index = safeY * width + safeX
    return activeMask[index] === 1 ? inputPixels[index]! : backgroundRgb
  }
  const sampleGrid = (x: number, y: number): RGB => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const tx = x - x0
    const ty = y - y0
    const topLeft = gridPixel(x0, y0)
    const topRight = gridPixel(x0 + 1, y0)
    const bottomLeft = gridPixel(x0, y0 + 1)
    const bottomRight = gridPixel(x0 + 1, y0 + 1)
    return [0, 1, 2].map((channel) => Math.round(
      topLeft[channel]! * (1 - tx) * (1 - ty)
        + topRight[channel]! * tx * (1 - ty)
        + bottomLeft[channel]! * (1 - tx) * ty
        + bottomRight[channel]! * tx * ty,
    )) as unknown as RGB
  }
  const pixels: RGB[] = []
  for (let cell = 0; cell < activeMask.length; cell += 1) {
    if (activeMask[cell] !== 1) {
      pixels.push(backgroundRgb)
      continue
    }
    const sourceX = sourceMapping[cell * 2]!
    const sourceY = sourceMapping[cell * 2 + 1]!
    if (Number.isFinite(sourceX) === false || Number.isFinite(sourceY) === false) {
      throw new RangeError('Source mapping coordinates must be finite')
    }
    const x = cell % width
    const y = Math.floor(cell / width)
    const defaultPoint = sourcePointForGridCell(crop, fit, x, y)
    if (defaultPoint === undefined) {
      pixels.push(backgroundRgb)
      continue
    }
    const deltaX = (sourceX - defaultPoint[0]) / (crop.width / fit.width)
    const deltaY = (sourceY - defaultPoint[1]) / (crop.height / fit.height)
    pixels.push(sampleGrid(x + deltaX, y + deltaY))
  }
  return pixels
}

function transformChannel(value: number, contrast: number, brightness: number): number {
  return clamp(Math.round((value - 128) * contrast + 128 + brightness), 0, 255)
}

export function applyStyle(pixel: RGB, style: PatternStyle): RGB {
  const settings: Record<PatternStyle, readonly [number, number, number]> = {
    faithful: [1, 0, 1],
    cute: [1.08, 12, 1.12],
    simple: [1.02, 2, 0.92],
    'high-contrast': [1.24, 0, 1.08],
    soft: [0.82, 10, 0.82],
  }
  const [contrast, brightness, saturation] = settings[style]
  const base = pixel.map((channel) => transformChannel(channel, contrast, brightness)) as unknown as RGB
  const luminance = base[0] * 0.2126 + base[1] * 0.7152 + base[2] * 0.0722
  return [0, 1, 2].map((channel) => clamp(
    Math.round(luminance + (base[channel]! - luminance) * saturation),
    0,
    255,
  )) as unknown as RGB
}
