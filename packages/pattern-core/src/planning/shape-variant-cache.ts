import { fitCropToCanvas } from '../image.js'
import {
  rasterizeSourceShape,
  shapeRasterizationThreshold,
  type ShapeRasterization,
  type SourceShapeModel,
} from '../shape.js'
import type { CropRect, GridSize, ImageLandmark } from '../types.js'

export interface ShapeVariantRequest {
  crop: CropRect
  size: GridSize
  refinementIterations: number
  preserveThinStructures?: boolean
}

function variantKey(request: ShapeVariantRequest): string {
  return JSON.stringify({
    crop: request.crop,
    size: request.size,
    threshold: shapeRasterizationThreshold,
    refinementIterations: request.refinementIterations,
    preserveThinStructures: request.preserveThinStructures === true,
  })
}

export class ShapeVariantCache {
  readonly #sourceShape: SourceShapeModel
  readonly #landmarks: readonly ImageLandmark[]
  readonly #variants = new Map<string, ShapeRasterization>()

  constructor(sourceShape: SourceShapeModel, landmarks: readonly ImageLandmark[]) {
    this.#sourceShape = sourceShape
    this.#landmarks = landmarks
  }

  get(request: ShapeVariantRequest): ShapeRasterization | undefined {
    if ([request.crop.x, request.crop.y, request.crop.width, request.crop.height]
      .some((value) => Number.isFinite(value) === false)
      || request.crop.width <= 0 || request.crop.height <= 0) {
      throw new RangeError('Shape variant crop must contain finite positive dimensions')
    }
    if (Number.isInteger(request.size.width) === false || request.size.width <= 0
      || Number.isInteger(request.size.height) === false || request.size.height <= 0) {
      throw new RangeError('Shape variant size must contain positive integers')
    }
    if (Number.isInteger(request.refinementIterations) === false
      || request.refinementIterations < 0 || request.refinementIterations > 32) {
      throw new RangeError('Shape variant refinement iterations must stay within 0..32')
    }
    if (request.preserveThinStructures !== undefined
      && typeof request.preserveThinStructures !== 'boolean') {
      throw new TypeError('Shape variant thin-structure protection must be boolean')
    }
    if (this.#sourceShape.foregroundArea === 0) return undefined
    const key = variantKey(request)
    const cached = this.#variants.get(key)
    if (cached !== undefined) return cached
    const rasterization = rasterizeSourceShape(
      this.#sourceShape,
      request.crop,
      fitCropToCanvas(request.crop, request.size.width, request.size.height),
      request.size.width,
      request.size.height,
      this.#landmarks,
      {
        refinementIterations: request.refinementIterations,
        preserveThinStructures: request.preserveThinStructures === true,
      },
    )
    this.#variants.set(key, rasterization)
    return rasterization
  }

  get size(): number {
    return this.#variants.size
  }
}
