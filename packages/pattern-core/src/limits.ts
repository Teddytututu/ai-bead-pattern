/** Algorithm limits; clients may expose smaller product budgets. */
export const patternLimits = Object.freeze({
  maxImageSide: 2_048,
  maxImagePixels: 4_000_000,
  maxCanvasSide: 96,
  maxCanvasCells: 9_216,
  maxPaletteColors: 512,
  maxSelectedColors: 48,
  maxCanvasCandidates: 12,
  maxGeneratedCandidates: 20,
})
