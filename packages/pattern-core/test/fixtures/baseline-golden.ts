import type { MaterialPalette, PixelImage } from '../../src/index.js'

export const baselineGoldenPalette: MaterialPalette = {
  id: 'baseline-golden',
  name: 'Baseline golden palette',
  colors: [
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
    { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] },
    { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255] },
  ],
}

const pixels = [
  [255, 0, 0], [255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255], [0, 0, 255],
  [255, 0, 0], [255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255], [0, 0, 255],
  [255, 255, 255], [255, 255, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255],
  [255, 255, 255], [255, 255, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255], [0, 0, 255],
] as const

const data = new Uint8ClampedArray(6 * 4 * 4)
pixels.forEach((pixel, index) => {
  data.set([pixel[0], pixel[1], pixel[2], 255], index * 4)
})

export const baselineGoldenImage: PixelImage = { width: 6, height: 4, data }

export const baselineGoldenCells = [
  { x: 0, y: 0, colorId: 'red' },
  { x: 1, y: 0, colorId: 'blue' },
  { x: 2, y: 0, colorId: 'blue' },
  { x: 0, y: 1, colorId: 'white' },
  { x: 1, y: 1, colorId: 'blue' },
  { x: 2, y: 1, colorId: 'blue' },
] as const
