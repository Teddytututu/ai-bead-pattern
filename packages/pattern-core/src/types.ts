export type RGB = readonly [red: number, green: number, blue: number]

export type Lab = readonly [lightness: number, a: number, b: number]

export interface PixelImage {
  width: number
  height: number
  /** Row-major RGBA bytes. The expected length is width * height * 4. */
  data: Uint8ClampedArray
}

export interface MaterialColor {
  id: string
  name: string
  hex: string
  rgb: RGB
  lab?: Lab
}

export interface MaterialPalette {
  id: string
  name: string
  colors: readonly MaterialColor[]
}

export type ImageType = 'portrait' | 'pet' | 'illustration' | 'landscape' | 'general'

export type ResizeMethod = 'area' | 'bilinear' | 'nearest'

export type ColorDistanceMethod = 'delta-e-76' | 'delta-e-2000'

export interface OptimizationOptions {
  minRegionSize?: number
  isolatedPixelPenalty?: number
  edgeProtection?: number
  stripePenalty?: number
}

export interface PatternOptions {
  width: number
  height: number
  maxColors: number
  imageType?: ImageType
  resizeMethod?: ResizeMethod
  colorDistanceMethod?: ColorDistanceMethod
  aiEnhancement?: boolean
  optimization?: OptimizationOptions
  beadDiameterMm?: number
}

export interface ImportanceMap {
  width: number
  height: number
  /** Row-major weights in the inclusive range 0..1. */
  weights: Float32Array
}

export interface ImageAnalysis {
  importanceMap?: ImportanceMap
  suggestedCrop?: CropRect
  imageType?: ImageType
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PatternCell {
  x: number
  y: number
  colorId: string
}

export interface PatternMetadata {
  sourceWidth: number
  sourceHeight: number
  totalBeads: number
  generatedAt: number
  algorithmVersion: string
  aiEnhanced: boolean
  aiProvider?: string
  aiModel?: string
  beadDiameterMm?: number
}

export interface BeadPattern {
  width: number
  height: number
  palette: readonly MaterialColor[]
  cells: readonly PatternCell[]
  metadata: PatternMetadata
}

export interface MaterialCount {
  colorId: string
  count: number
}

export interface GenerationMetrics {
  processingTimeMs: number
  uniqueColors: number
  removedSmallRegions: number
  totalBeads: number
}

export interface PatternGenerationRequest {
  image: PixelImage
  palette: MaterialPalette
  options: PatternOptions
  analysis?: ImageAnalysis
}

export interface PatternGenerationResult {
  pattern: BeadPattern
  materialCounts: readonly MaterialCount[]
  metrics: GenerationMetrics
}
