import type {
  BinaryMask,
  CropRect,
  ImageLandmark,
  PixelImage,
} from './types.js'

export interface PetAnalysisResult {
  imageType: 'pet'
  landmarks: readonly ImageLandmark[]
  faceMask: BinaryMask
  suggestedCrop: CropRect
  suggestedCropConfidence: number
  confidence: number
}

interface PointScore {
  x: number
  y: number
  score: number
}

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validate(image: PixelImage, mask: BinaryMask): void {
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new RangeError('Pet analysis image and mask dimensions must match')
  }
  if (image.data.length !== image.width * image.height * 4
    || mask.values.length !== mask.width * mask.height) {
    throw new RangeError('Pet analysis buffers must align with their dimensions')
  }
}

function maskBounds(mask: BinaryMask): Bounds | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) return undefined
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

function luminance(image: PixelImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4
  return ((image.data[index] ?? 0) * 0.2126
    + (image.data[index + 1] ?? 0) * 0.7152
    + (image.data[index + 2] ?? 0) * 0.0722) / 255
}

function saturation(image: PixelImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4
  const values = [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0]
  return (Math.max(...values) - Math.min(...values)) / 255
}

function redExcess(image: PixelImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4
  const red = image.data[index] ?? 0
  const green = image.data[index + 1] ?? 0
  const blue = image.data[index + 2] ?? 0
  return clamp((red - (green + blue) / 2) / 128, 0, 1)
}

function localContrast(image: PixelImage, x: number, y: number, radius: number): number {
  let minimum = 1
  let maximum = 0
  for (let sampleY = Math.max(0, y - radius); sampleY <= Math.min(image.height - 1, y + radius); sampleY += 1) {
    for (let sampleX = Math.max(0, x - radius); sampleX <= Math.min(image.width - 1, x + radius); sampleX += 1) {
      const value = luminance(image, sampleX, sampleY)
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
  }
  return maximum - minimum
}

function eyeCandidates(
  image: PixelImage,
  mask: BinaryMask,
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
  expectedX: number,
  expectedY: number,
  radiusX: number,
  radiusY: number,
  contrastRadius: number,
): readonly PointScore[] {
  const candidates: PointScore[] = []
  for (let y = Math.max(0, Math.floor(minimumY)); y <= Math.min(image.height - 1, Math.ceil(maximumY)); y += 1) {
    for (let x = Math.max(0, Math.floor(minimumX)); x <= Math.min(image.width - 1, Math.ceil(maximumX)); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(
        (x - expectedX) / Math.max(1, radiusX),
        (y - expectedY) / Math.max(1, radiusY),
      )
      const score = (1 - luminance(image, x, y)) * 0.3
        + saturation(image, x, y) * 0.16
        + localContrast(image, x, y, contrastRadius) * 0.28
        + clamp(1 - distance, 0, 1) * 0.26
      candidates.push({ x, y, score })
    }
  }
  candidates.sort((first, second) => second.score - first.score || first.y - second.y || first.x - second.x)
  const selected: PointScore[] = []
  const suppressionRadius = Math.max(2, contrastRadius)
  for (const candidate of candidates) {
    if (selected.some((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) < suppressionRadius)) continue
    selected.push(candidate)
    if (selected.length >= 24) break
  }
  return selected
}

function eyePair(
  image: PixelImage,
  mask: BinaryMask,
  centerX: number,
  faceWidth: number,
  earTop: number,
): readonly [PointScore, PointScore] {
  const expectedY = earTop + faceWidth * 0.58
  const minimumY = earTop + faceWidth * 0.3
  const maximumY = earTop + faceWidth * 0.78
  const contrastRadius = Math.max(2, Math.round(faceWidth * 0.022))
  const left = eyeCandidates(
    image,
    mask,
    centerX - faceWidth * 0.42,
    centerX - faceWidth * 0.015,
    minimumY,
    maximumY,
    centerX - faceWidth * 0.15,
    expectedY,
    faceWidth * 0.28,
    faceWidth * 0.28,
    contrastRadius,
  )
  const right = eyeCandidates(
    image,
    mask,
    centerX + faceWidth * 0.015,
    centerX + faceWidth * 0.42,
    minimumY,
    maximumY,
    centerX + faceWidth * 0.15,
    expectedY,
    faceWidth * 0.28,
    faceWidth * 0.28,
    contrastRadius,
  )
  let best: { left: PointScore, right: PointScore, score: number } | undefined
  for (const leftPoint of left) {
    for (const rightPoint of right) {
      const separation = (rightPoint.x - leftPoint.x) / faceWidth
      if (separation < 0.16 || separation > 0.58) continue
      const separationScore = clamp(1 - Math.abs(separation - 0.3) / 0.18, 0, 1)
      const alignmentScore = clamp(1 - Math.abs(rightPoint.y - leftPoint.y) / Math.max(1, faceWidth * 0.16), 0, 1)
      const midpoint = (leftPoint.x + rightPoint.x) / 2
      const centerScore = clamp(1 - Math.abs(midpoint - centerX) / Math.max(1, faceWidth * 0.2), 0, 1)
      const score = (leftPoint.score + rightPoint.score) * 0.3
        + separationScore * 0.25
        + alignmentScore * 0.1
        + centerScore * 0.05
      if (best === undefined || score > best.score) best = { left: leftPoint, right: rightPoint, score }
    }
  }
  return best === undefined
    ? [
        left[0] ?? { x: centerX - faceWidth * 0.15, y: expectedY, score: 0 },
        right[0] ?? { x: centerX + faceWidth * 0.15, y: expectedY, score: 0 },
      ]
    : [best.left, best.right]
}

function refineEyeCenter(
  image: PixelImage,
  mask: BinaryMask,
  point: PointScore,
  radius: number,
): PointScore {
  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0
  const integerRadius = Math.max(2, Math.round(radius))
  for (let y = Math.max(0, point.y - integerRadius); y <= Math.min(image.height - 1, point.y + integerRadius); y += 1) {
    for (let x = Math.max(0, point.x - integerRadius); x <= Math.min(image.width - 1, point.x + integerRadius); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(x - point.x, y - point.y) / integerRadius
      if (distance > 1) continue
      const chroma = saturation(image, x, y)
      const value = luminance(image, x, y)
      const weight = chroma * Math.max(0, value - 0.04) * (1 - distance * 0.65)
      weightedX += x * weight
      weightedY += y * weight
      totalWeight += weight
    }
  }
  if (totalWeight < 0.1) return point
  return {
    x: weightedX / totalWeight,
    y: weightedY / totalWeight,
    score: point.score,
  }
}

function noseFeature(
  image: PixelImage,
  mask: BinaryMask,
  expectedX: number,
  expectedY: number,
  radius: number,
): PointScore {
  let best: PointScore = { x: Math.round(expectedX), y: Math.round(expectedY), score: 0 }
  for (let y = Math.max(0, Math.floor(expectedY - radius)); y <= Math.min(image.height - 1, Math.ceil(expectedY + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(expectedX - radius)); x <= Math.min(image.width - 1, Math.ceil(expectedX + radius)); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(x - expectedX, y - expectedY) / Math.max(1, radius)
      const score = redExcess(image, x, y) * 0.5
        + saturation(image, x, y) * 0.2
        + (1 - luminance(image, x, y)) * 0.12
        + clamp(1 - distance, 0, 1) * 0.18
      if (score > best.score) best = { x, y, score }
    }
  }
  return best
}

function earTips(mask: BinaryMask, bounds: Bounds): readonly [PointScore, PointScore] | undefined {
  const centerX = (bounds.left + bounds.right) / 2
  const limitY = bounds.top + bounds.height * 0.38
  const candidates: PointScore[] = []
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    for (let y = bounds.top; y <= limitY; y += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      candidates.push({
        x,
        y,
        score: 1 - (y - bounds.top) / Math.max(1, limitY - bounds.top),
      })
      break
    }
  }
  let best: { left: PointScore, right: PointScore, score: number } | undefined
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!
      const separation = (right.x - left.x) / bounds.width
      if (separation < 0.2 || separation > 0.78) continue
      const separationScore = clamp(1 - Math.abs(separation - 0.46) / 0.32, 0, 1)
      const pairCenter = (left.x + right.x) / 2
      const centerScore = clamp(1 - Math.abs(pairCenter - centerX) / Math.max(1, bounds.width * 0.42), 0, 1)
      const verticalScore = (left.score + right.score) / 2
      const heightCompatibility = clamp(1 - Math.abs(left.y - right.y) / Math.max(1, bounds.height * 0.28), 0, 1)
      const score = verticalScore * 0.46
        + separationScore * 0.28
        + centerScore * 0.12
        + heightCompatibility * 0.14
      if (best === undefined || score > best.score) best = { left, right, score }
    }
  }
  return best === undefined ? undefined : [best.left, best.right]
}

function pointInTriangle(
  x: number,
  y: number,
  first: { x: number, y: number },
  second: { x: number, y: number },
  third: { x: number, y: number },
): boolean {
  const sign = (
    point: { x: number, y: number },
    edgeStart: { x: number, y: number },
    edgeEnd: { x: number, y: number },
  ) => (point.x - edgeEnd.x) * (edgeStart.y - edgeEnd.y)
    - (edgeStart.x - edgeEnd.x) * (point.y - edgeEnd.y)
  const point = { x, y }
  const firstSign = sign(point, first, second)
  const secondSign = sign(point, second, third)
  const thirdSign = sign(point, third, first)
  const hasNegative = firstSign < 0 || secondSign < 0 || thirdSign < 0
  const hasPositive = firstSign > 0 || secondSign > 0 || thirdSign > 0
  return hasNegative === false || hasPositive === false
}

function petFaceMask(
  subjectMask: BinaryMask,
  leftEar: PointScore,
  rightEar: PointScore,
  leftEye: PointScore,
  rightEye: PointScore,
  faceCenterX: number,
  eyeY: number,
  chin: { x: number, y: number },
  faceWidth: number,
): BinaryMask {
  const values = new Float32Array(subjectMask.values.length)
  const ellipseCenterY = eyeY + faceWidth * 0.13
  const radiusX = faceWidth * 0.44
  const radiusY = Math.max(faceWidth * 0.36, chin.y - ellipseCenterY)
  const earBaseY = eyeY - faceWidth * 0.08
  const earHalfWidth = faceWidth * 0.18
  const leftEarBase = [
    { x: leftEye.x - earHalfWidth, y: earBaseY },
    { x: leftEye.x + earHalfWidth, y: earBaseY },
  ] as const
  const rightEarBase = [
    { x: rightEye.x - earHalfWidth, y: earBaseY },
    { x: rightEye.x + earHalfWidth, y: earBaseY },
  ] as const
  for (let y = 0; y < subjectMask.height; y += 1) {
    for (let x = 0; x < subjectMask.width; x += 1) {
      const index = y * subjectMask.width + x
      const subjectValue = subjectMask.values[index] ?? 0
      if (subjectValue <= 0) continue
      const ellipse = ((x - faceCenterX) / radiusX) ** 2
        + ((y - ellipseCenterY) / radiusY) ** 2 <= 1
      const leftTriangle = pointInTriangle(x, y, leftEar, leftEarBase[0], leftEarBase[1])
      const rightTriangle = pointInTriangle(x, y, rightEar, rightEarBase[0], rightEarBase[1])
      if (ellipse || leftTriangle || rightTriangle) values[index] = subjectValue
    }
  }
  return { width: subjectMask.width, height: subjectMask.height, values }
}

function landmark(
  id: string,
  kind: ImageLandmark['kind'],
  point: { x: number, y: number },
  confidence: number,
  options: Partial<ImageLandmark> = {},
): ImageLandmark {
  return {
    id,
    kind,
    x: point.x,
    y: point.y,
    confidence: clamp(confidence, 0, 1),
    priority: kind === 'face-contour' ? 'soft' : 'hard',
    sourceRadiusPx: kind === 'eye' ? 3 : kind === 'nose' ? 2 : 1,
    gridRadiusCells: kind === 'eye' ? 1 : 0.5,
    carrierRegionId: 'pet-face',
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v1' }],
    ...options,
  }
}

export function inferPetAnalysis(image: PixelImage, mask: BinaryMask): PetAnalysisResult | undefined {
  validate(image, mask)
  const bounds = maskBounds(mask)
  if (bounds === undefined || bounds.width < 6 || bounds.height < 6) return undefined
  const ears = earTips(mask, bounds)
  if (ears === undefined) return undefined
  const [leftEar, rightEar] = ears
  const earSeparation = rightEar.x - leftEar.x
  if (earSeparation < bounds.width * 0.18) return undefined
  const centerX = (leftEar.x + rightEar.x) / 2
  const faceWidth = clamp(earSeparation * 1.55, bounds.width * 0.35, bounds.width * 0.82)
  const earTop = Math.min(leftEar.y, rightEar.y)
  const noseSeed = noseFeature(
    image,
    mask,
    centerX,
    Math.min(bounds.bottom, earTop + faceWidth * 0.8),
    faceWidth * 0.18,
  )
  const faceAxisX = noseSeed.score >= 0.28
    ? centerX * 0.2 + noseSeed.x * 0.8
    : centerX
  const [rawLeftEye, rawRightEye] = eyePair(
    image,
    mask,
    faceAxisX,
    faceWidth,
    earTop,
  )
  const leftEye = refineEyeCenter(image, mask, rawLeftEye, faceWidth * 0.07)
  const rightEye = refineEyeCenter(image, mask, rawRightEye, faceWidth * 0.07)
  const eyeY = (leftEye.y + rightEye.y) / 2
  const eyeMidpointX = (leftEye.x + rightEye.x) / 2
  const nose = noseFeature(image, mask, eyeMidpointX, eyeY + faceWidth * 0.21, faceWidth * 0.13)
  const earSymmetry = clamp(1 - Math.abs(leftEar.y - rightEar.y) / Math.max(1, faceWidth * 0.35), 0, 1)
  const eyeSymmetry = clamp(1 - Math.abs(leftEye.y - rightEye.y) / Math.max(1, faceWidth * 0.12), 0, 1)
  const eyeEvidence = clamp((leftEye.score + rightEye.score) / 2, 0, 1)
  const confidence = clamp(
    earSymmetry * 0.22 + eyeSymmetry * 0.18 + eyeEvidence * 0.38 + nose.score * 0.22,
    0,
    1,
  )
  if (confidence < 0.3) return undefined

  const faceCenterX = nose.x * 0.6 + faceAxisX * 0.4
  const faceLeft = { x: clamp(faceCenterX - faceWidth * 0.48, bounds.left, bounds.right), y: eyeY + faceWidth * 0.12 }
  const faceRight = { x: clamp(faceCenterX + faceWidth * 0.48, bounds.left, bounds.right), y: eyeY + faceWidth * 0.12 }
  const chin = { x: faceCenterX, y: clamp(nose.y + faceWidth * 0.28, bounds.top, bounds.bottom) }
  const cropLeft = clamp(Math.floor(faceCenterX - faceWidth * 0.72), 0, image.width - 1)
  const cropRight = clamp(Math.ceil(faceCenterX + faceWidth * 0.72), cropLeft + 1, image.width)
  const cropTop = clamp(Math.floor(Math.min(leftEar.y, rightEar.y) - faceWidth * 0.14), 0, image.height - 1)
  const cropBottom = clamp(Math.ceil(chin.y + faceWidth * 0.34), cropTop + 1, image.height)
  const landmarks = [
    landmark('left-ear-tip', 'ear', leftEar, confidence, { symmetryGroup: 'ears', affectsOccupancy: true }),
    landmark('right-ear-tip', 'ear', rightEar, confidence, { symmetryGroup: 'ears', affectsOccupancy: true }),
    landmark('left-eye-center', 'eye', leftEye, leftEye.score, { symmetryGroup: 'eyes' }),
    landmark('right-eye-center', 'eye', rightEye, rightEye.score, { symmetryGroup: 'eyes' }),
    landmark('nose-tip', 'nose', nose, nose.score),
    landmark('face-left', 'face-contour', faceLeft, confidence, { symmetryGroup: 'face-sides', affectsOccupancy: true }),
    landmark('face-right', 'face-contour', faceRight, confidence, { symmetryGroup: 'face-sides', affectsOccupancy: true }),
    landmark('chin', 'face-contour', chin, confidence, { affectsOccupancy: true }),
  ]
  return {
    imageType: 'pet',
    landmarks,
    faceMask: petFaceMask(
      mask,
      leftEar,
      rightEar,
      leftEye,
      rightEye,
      faceCenterX,
      eyeY,
      chin,
      faceWidth,
    ),
    suggestedCrop: {
      x: cropLeft,
      y: cropTop,
      width: cropRight - cropLeft,
      height: cropBottom - cropTop,
    },
    suggestedCropConfidence: confidence,
    confidence,
  }
}
