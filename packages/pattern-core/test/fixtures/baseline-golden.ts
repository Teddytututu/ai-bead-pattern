import type {
  ImageAnalysis,
  MaterialPalette,
  OptimizationOptions,
  PatternCell,
  PixelImage,
} from '../../src/index.js'

export const baselineGoldenPalette: MaterialPalette = {
  id: 'baseline-golden',
  name: 'Baseline golden palette',
  colors: [
    { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255] },
    { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] },
  ],
}

function pixelImage(
  width: number,
  height: number,
  pixels: readonly (readonly [number, number, number])[],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  pixels.forEach((pixel, index) => data.set([...pixel, 255], index * 4))
  return { width, height, data }
}

const red = [255, 0, 0] as const
const blue = [0, 0, 255] as const

export const samplingGoldenImage = pixelImage(4, 1, [blue, red, blue, red])

export const samplingGoldenCells = {
  a0: [
    { x: 0, y: 0, colorId: 'red' },
    { x: 1, y: 0, colorId: 'red' },
  ],
  a1: [
    { x: 0, y: 0, colorId: 'blue' },
    { x: 1, y: 0, colorId: 'blue' },
  ],
} as const satisfies Readonly<Record<'a0' | 'a1', readonly PatternCell[]>>

export const structureGoldenImage = pixelImage(3, 3, [
  blue, blue, blue,
  red, blue, red,
  blue, blue, blue,
])

export const structureGoldenCells = {
  a1: [
    { x: 0, y: 0, colorId: 'blue' }, { x: 1, y: 0, colorId: 'blue' }, { x: 2, y: 0, colorId: 'blue' },
    { x: 0, y: 1, colorId: 'red' }, { x: 1, y: 1, colorId: 'blue' }, { x: 2, y: 1, colorId: 'red' },
    { x: 0, y: 2, colorId: 'blue' }, { x: 1, y: 2, colorId: 'blue' }, { x: 2, y: 2, colorId: 'blue' },
  ],
  mvp: [
    { x: 0, y: 0, colorId: 'blue' }, { x: 1, y: 0, colorId: 'blue' }, { x: 2, y: 0, colorId: 'blue' },
    { x: 0, y: 1, colorId: 'red' }, { x: 1, y: 1, colorId: 'red' }, { x: 2, y: 1, colorId: 'red' },
    { x: 0, y: 2, colorId: 'blue' }, { x: 1, y: 2, colorId: 'blue' }, { x: 2, y: 2, colorId: 'blue' },
  ],
} as const satisfies Readonly<Record<'a1' | 'mvp', readonly PatternCell[]>>

export const featureGoldenImage = pixelImage(3, 3, [
  red, red, red,
  red, blue, red,
  red, red, red,
])

export const featureGoldenAnalysis: ImageAnalysis = {
  confidence: 1,
  landmarks: [{
    id: 'eye',
    kind: 'eye',
    x: 1,
    y: 1,
    confidence: 1,
    priority: 'hard',
    gridRadiusCells: 0,
  }],
}

export const featureGoldenOptimization: OptimizationOptions = {
  minRegionSize: 2,
  isolatedPixelPenalty: 1,
  stripePenalty: 0,
  aliasPenalty: 0,
  paletteCoherence: 0,
  localSearchIterations: 0,
}

export const protectedFeatureGoldenCells = [
  { x: 0, y: 0, colorId: 'red' }, { x: 1, y: 0, colorId: 'red' }, { x: 2, y: 0, colorId: 'red' },
  { x: 0, y: 1, colorId: 'red' }, { x: 1, y: 1, colorId: 'blue' }, { x: 2, y: 1, colorId: 'red' },
  { x: 0, y: 2, colorId: 'red' }, { x: 1, y: 2, colorId: 'red' }, { x: 2, y: 2, colorId: 'red' },
] as const satisfies readonly PatternCell[]
