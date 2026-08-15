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

export function resizePixels(
  image: PixelImage,
  crop: CropRect,
  width: number,
  height: number,
  method: ResizeMethod,
  backgroundRgb: RGB = [255, 255, 255],
): readonly RGB[] {
  const pixels: RGB[] = []
  const scaleX = crop.width / width
  const scaleY = crop.height / height
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (method === 'nearest') {
        pixels.push(nearestSample(
          image,
          crop.x + (x + 0.5) * scaleX - 0.5,
          crop.y + (y + 0.5) * scaleY - 0.5,
          backgroundRgb,
        ))
      } else if (method === 'bilinear' || scaleX < 1 || scaleY < 1) {
        pixels.push(bilinearSample(
          image,
          crop.x + (x + 0.5) * scaleX - 0.5,
          crop.y + (y + 0.5) * scaleY - 0.5,
          backgroundRgb,
        ))
      } else {
        pixels.push(areaSample(
          image,
          crop.x + x * scaleX,
          crop.y + y * scaleY,
          crop.x + (x + 1) * scaleX,
          crop.y + (y + 1) * scaleY,
          backgroundRgb,
        ))
      }
    }
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
