import type { ColorDistanceMethod, Lab, MaterialColor, RGB } from './types.js'

const degreesToRadians = Math.PI / 180
const radiansToDegrees = 180 / Math.PI

function srgbChannelToLinear(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

function xyzPivot(value: number): number {
  const delta = 6 / 29
  return value > delta ** 3
    ? Math.cbrt(value)
    : value / (3 * delta ** 2) + 4 / 29
}

export function rgbToLab(rgb: RGB): Lab {
  const red = srgbChannelToLinear(rgb[0])
  const green = srgbChannelToLinear(rgb[1])
  const blue = srgbChannelToLinear(rgb[2])
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883
  const fx = xyzPivot(x)
  const fy = xyzPivot(y)
  const fz = xyzPivot(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function deltaE76(first: Lab, second: Lab): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
}

function normalizeHue(degrees: number): number {
  return degrees >= 0 ? degrees : degrees + 360
}

export function deltaE2000(first: Lab, second: Lab): number {
  const [l1, a1, b1] = first
  const [l2, a2, b2] = second
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const meanC = (c1 + c2) / 2
  const meanC7 = meanC ** 7
  const g = 0.5 * (1 - Math.sqrt(meanC7 / (meanC7 + 25 ** 7)))
  const adjustedA1 = (1 + g) * a1
  const adjustedA2 = (1 + g) * a2
  const adjustedC1 = Math.hypot(adjustedA1, b1)
  const adjustedC2 = Math.hypot(adjustedA2, b2)
  const hue1 = normalizeHue(Math.atan2(b1, adjustedA1) * radiansToDegrees)
  const hue2 = normalizeHue(Math.atan2(b2, adjustedA2) * radiansToDegrees)
  const deltaL = l2 - l1
  const deltaC = adjustedC2 - adjustedC1
  const rawHueDelta = hue2 - hue1
  const hueDelta = adjustedC1 * adjustedC2 === 0
    ? 0
    : Math.abs(rawHueDelta) <= 180
      ? rawHueDelta
      : rawHueDelta > 180
        ? rawHueDelta - 360
        : rawHueDelta + 360
  const deltaH = 2 * Math.sqrt(adjustedC1 * adjustedC2)
    * Math.sin((hueDelta / 2) * degreesToRadians)
  const meanL = (l1 + l2) / 2
  const meanAdjustedC = (adjustedC1 + adjustedC2) / 2
  const meanHue = adjustedC1 * adjustedC2 === 0
    ? hue1 + hue2
    : Math.abs(rawHueDelta) <= 180
      ? (hue1 + hue2) / 2
      : hue1 + hue2 < 360
        ? (hue1 + hue2 + 360) / 2
        : (hue1 + hue2 - 360) / 2
  const t = 1
    - 0.17 * Math.cos((meanHue - 30) * degreesToRadians)
    + 0.24 * Math.cos(2 * meanHue * degreesToRadians)
    + 0.32 * Math.cos((3 * meanHue + 6) * degreesToRadians)
    - 0.20 * Math.cos((4 * meanHue - 63) * degreesToRadians)
  const lightnessTerm = (meanL - 50) ** 2
  const sL = 1 + (0.015 * lightnessTerm) / Math.sqrt(20 + lightnessTerm)
  const sC = 1 + 0.045 * meanAdjustedC
  const sH = 1 + 0.015 * meanAdjustedC * t
  const deltaTheta = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2))
  const meanAdjustedC7 = meanAdjustedC ** 7
  const rC = 2 * Math.sqrt(meanAdjustedC7 / (meanAdjustedC7 + 25 ** 7))
  const rT = -rC * Math.sin(2 * deltaTheta * degreesToRadians)
  const normalizedL = deltaL / sL
  const normalizedC = deltaC / sC
  const normalizedH = deltaH / sH
  return Math.sqrt(
    normalizedL ** 2 + normalizedC ** 2 + normalizedH ** 2 + rT * normalizedC * normalizedH,
  )
}

export function colorDistance(first: Lab, second: Lab, method: ColorDistanceMethod): number {
  return method === 'delta-e-76' ? deltaE76(first, second) : deltaE2000(first, second)
}

export interface PreparedColor extends MaterialColor {
  lab: Lab
}

export function prepareColors(colors: readonly MaterialColor[]): readonly PreparedColor[] {
  return colors.map((color) => ({ ...color, lab: color.lab ?? rgbToLab(color.rgb) }))
}

export function rgbDistance(first: RGB, second: RGB): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
}
