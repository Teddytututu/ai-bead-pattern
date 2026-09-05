import type {
  BinaryMask,
  CropRect,
  ImageLandmark,
  PixelImage,
  SemanticRegion,
} from './types.js'

export interface PetAnalysisResult {
  imageType: 'pet'
  headPose: 'frontal' | 'profile-left' | 'profile-right'
  landmarks: readonly ImageLandmark[]
  faceMask: BinaryMask
  bodyRegions: readonly SemanticRegion[]
  suggestedCrop: CropRect
  suggestedCropConfidence: number
  confidence: number
  frontalBodyEvidence?: FrontalBodyEvidence
}

export interface PetInstanceAnalysis extends PetAnalysisResult {
  instanceId: string
  instanceMask: BinaryMask
  bounds: CropRect
  sourceArea: number
  relativeArea: number
}

export interface PetInstanceGroupAnalysis {
  instances: readonly PetInstanceAnalysis[]
  subjectMask: BinaryMask
  suggestedCrop: CropRect
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

interface ProfileAnalysis {
  pose: 'profile-left' | 'profile-right'
  direction: -1 | 1
  ear: PointScore
  earRoot: PointScore
  eye: PointScore
  nose: PointScore
  mouth: PointScore
  upperJaw: PointScore
  lowerJaw: PointScore
  headWidth: number
  headHeight: number
  confidence: number
}

interface ProfileBodyAnalysis {
  neck: PointScore
  shoulder: PointScore
  chest: PointScore
  back: PointScore
  tailRoot: PointScore
  hip: PointScore
  frontKnee: PointScore
  frontPaw: PointScore
  rearKnee: PointScore
  rearPaw: PointScore
  tail: PointScore
}

interface FrontalFaceGeometry {
  centerX: number
  centerY: number
  radiusX: number
  radiusY: number
  chinY: number
  earBaseY: number
  earHalfWidth: number
  earOuterReach: number
}

export interface FrontalBodyEvidence {
  available: boolean
  bodyMassRatio: number
  belowFaceMassRatio: number
  lowerExtensionRatio: number
  lowerSupportRuns: number
  lowerSupportRows: number
  confidence: number
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

interface ConnectedMaskComponent {
  indices: readonly number[]
  bounds: Bounds
}

function connectedMaskComponents(mask: BinaryMask): readonly ConnectedMaskComponent[] {
  const visited = new Uint8Array(mask.values.length)
  const components: ConnectedMaskComponent[] = []
  for (let start = 0; start < mask.values.length; start += 1) {
    if (visited[start] !== 0 || (mask.values[start] ?? 0) < 0.5) continue
    const component: number[] = []
    let left = mask.width
    let top = mask.height
    let right = -1
    let bottom = -1
    const queue = [start]
    visited[start] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!
      component.push(current)
      const x = current % mask.width
      const y = Math.floor(current / mask.width)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue
          const nextX = x + offsetX
          const nextY = y + offsetY
          if (nextX < 0 || nextX >= mask.width || nextY < 0 || nextY >= mask.height) continue
          const next = nextY * mask.width + nextX
          if (visited[next] !== 0 || (mask.values[next] ?? 0) < 0.5) continue
          visited[next] = 1
          queue.push(next)
        }
      }
    }
    components.push({
      indices: component,
      bounds: { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 },
    })
  }
  return components.sort((first, second) =>
    second.indices.length - first.indices.length
      || first.bounds.top - second.bounds.top
      || first.bounds.left - second.bounds.left)
}

function componentMask(mask: BinaryMask, component: ConnectedMaskComponent): BinaryMask {
  const values = new Float32Array(mask.values.length)
  for (const index of component.indices) values[index] = mask.values[index] ?? 0
  return { width: mask.width, height: mask.height, values }
}

function principalComponentMask(mask: BinaryMask): BinaryMask {
  const selected = connectedMaskComponents(mask)[0]
  return selected === undefined ? mask : componentMask(mask, selected)
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

function maskPoint(mask: BinaryMask, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < mask.width && y < mask.height
    && (mask.values[y * mask.width + x] ?? 0) >= 0.5
}

function localMaskDensity(
  mask: BinaryMask,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
): number {
  let active = 0
  let cells = 0
  for (let sampleY = Math.max(0, y - radiusY); sampleY <= Math.min(mask.height - 1, y + radiusY); sampleY += 1) {
    for (let sampleX = Math.max(0, x - radiusX); sampleX <= Math.min(mask.width - 1, x + radiusX); sampleX += 1) {
      cells += 1
      if (maskPoint(mask, sampleX, sampleY)) active += 1
    }
  }
  return cells === 0 ? 0 : active / cells
}

function axisSpanFillRatio(mask: BinaryMask, bounds: Bounds, horizontal: boolean): number {
  const outerStart = horizontal ? bounds.top : bounds.left
  const outerEnd = horizontal ? bounds.bottom : bounds.right
  const innerStart = horizontal ? bounds.left : bounds.top
  const innerEnd = horizontal ? bounds.right : bounds.bottom
  let activeCells = 0
  let spanCells = 0
  for (let outer = outerStart; outer <= outerEnd; outer += 1) {
    let first = Infinity
    let last = -Infinity
    let active = 0
    for (let inner = innerStart; inner <= innerEnd; inner += 1) {
      const x = horizontal ? inner : outer
      const y = horizontal ? outer : inner
      if (maskPoint(mask, x, y) === false) continue
      first = Math.min(first, inner)
      last = Math.max(last, inner)
      active += 1
    }
    if (active === 0) continue
    activeCells += active
    spanCells += last - first + 1
  }
  return spanCells === 0 ? 0 : activeCells / spanCells
}

function flatGeometricNegativeEvidence(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
): number {
  let minimumRed = 255
  let minimumGreen = 255
  let minimumBlue = 255
  let maximumRed = 0
  let maximumGreen = 0
  let maximumBlue = 0
  let samples = 0
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (maskPoint(mask, x, y) === false) continue
      const offset = (y * image.width + x) * 4
      const red = image.data[offset] ?? 0
      const green = image.data[offset + 1] ?? 0
      const blue = image.data[offset + 2] ?? 0
      minimumRed = Math.min(minimumRed, red)
      minimumGreen = Math.min(minimumGreen, green)
      minimumBlue = Math.min(minimumBlue, blue)
      maximumRed = Math.max(maximumRed, red)
      maximumGreen = Math.max(maximumGreen, green)
      maximumBlue = Math.max(maximumBlue, blue)
      samples += 1
    }
  }
  if (samples === 0) return 0
  const colorRange = Math.max(
    maximumRed - minimumRed,
    maximumGreen - minimumGreen,
    maximumBlue - minimumBlue,
  ) / 255
  const flatness = clamp(1 - colorRange / 0.08, 0, 1)
  const horizontalConvexity = axisSpanFillRatio(mask, bounds, true)
  const verticalConvexity = axisSpanFillRatio(mask, bounds, false)
  return flatness * Math.min(horizontalConvexity, verticalConvexity)
}

function strongestPoint(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
  scoreAt: (x: number, y: number) => number,
): PointScore {
  let best: PointScore = { x: bounds.left, y: bounds.top, score: 0 }
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (maskPoint(mask, x, y) === false) continue
      const score = scoreAt(x, y)
      if (score > best.score) best = { x, y, score }
    }
  }
  return best
}

function profileTipCandidate(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
  direction: -1 | 1,
  headTop: number,
  headBottom: number,
  headCenterX: number,
  headWidth: number,
): PointScore {
  const band: Bounds = {
    left: bounds.left,
    right: bounds.right,
    top: Math.max(bounds.top, Math.floor(headTop + (headBottom - headTop) * 0.18)),
    bottom: Math.min(bounds.bottom, Math.ceil(headTop + (headBottom - headTop) * 0.78)),
    width: bounds.width,
    height: Math.max(1, headBottom - headTop + 1),
  }
  return strongestPoint(image, mask, band, (x, y) => {
    const forward = clamp(direction * (x - headCenterX) / Math.max(1, headWidth * 0.5), 0, 1)
    const vertical = clamp(1 - Math.abs(y - (headTop + band.height * 0.48)) / Math.max(1, band.height * 0.42), 0, 1)
    const support = localMaskDensity(
      mask,
      x,
      y,
      Math.max(2, Math.round(headWidth * 0.025)),
      Math.max(2, Math.round(band.height * 0.06)),
    )
    return forward * 0.2
      + (1 - luminance(image, x, y)) * 0.27
      + localContrast(image, x, y, Math.max(1, Math.round(headWidth * 0.025))) * 0.24
      + clamp((support - 0.12) / 0.45, 0, 1) * 0.22
      + redExcess(image, x, y) * 0.08
      + vertical * 0.05
  })
}

function limitProfileRetreat(
  point: PointScore,
  nose: PointScore,
  direction: -1 | 1,
  maximumRetreat: number,
): PointScore {
  const retreat = clamp(direction * (nose.x - point.x), 0, maximumRetreat)
  return { ...point, x: Math.round(nose.x - direction * retreat) }
}

function profileFeature(
  image: PixelImage,
  mask: BinaryMask,
  expectedX: number,
  expectedY: number,
  radiusX: number,
  radiusY: number,
): PointScore {
  const bounds: Bounds = {
    left: Math.max(0, Math.floor(expectedX - radiusX)),
    right: Math.min(image.width - 1, Math.ceil(expectedX + radiusX)),
    top: Math.max(0, Math.floor(expectedY - radiusY)),
    bottom: Math.min(image.height - 1, Math.ceil(expectedY + radiusY)),
    width: Math.max(1, Math.ceil(radiusX * 2)),
    height: Math.max(1, Math.ceil(radiusY * 2)),
  }
  return strongestPoint(image, mask, bounds, (x, y) => {
    const distance = Math.hypot(
      (x - expectedX) / Math.max(1, radiusX),
      (y - expectedY) / Math.max(1, radiusY),
    )
    return (1 - luminance(image, x, y)) * 0.34
      + localContrast(image, x, y, Math.max(1, Math.round(Math.min(radiusX, radiusY) * 0.2))) * 0.34
      + saturation(image, x, y) * 0.12
      + clamp(1 - distance, 0, 1) * 0.2
  })
}

function profileBoundaryPoint(
  mask: BinaryMask,
  bounds: Bounds,
  direction: -1 | 1,
  expectedY: number,
  radiusY: number,
  inward: number,
): PointScore {
  let best: PointScore | undefined
  for (let y = Math.max(bounds.top, Math.floor(expectedY - radiusY));
    y <= Math.min(bounds.bottom, Math.ceil(expectedY + radiusY)); y += 1) {
    const start = direction === 1 ? bounds.right : bounds.left
    const end = direction === 1 ? bounds.left : bounds.right
    for (let x = start; direction === 1 ? x >= end : x <= end; x -= direction) {
      if (maskPoint(mask, x, y) === false) continue
      const targetX = x - direction * inward
      const resolvedX = Math.round(clamp(targetX, bounds.left, bounds.right))
      if (maskPoint(mask, resolvedX, y)) {
        const score = 1 - Math.abs(y - expectedY) / Math.max(1, radiusY)
        if (best === undefined || score > best.score) best = { x: resolvedX, y, score }
      }
      break
    }
  }
  return best ?? {
    x: Math.round(clamp(direction === 1 ? bounds.right - inward : bounds.left + inward, bounds.left, bounds.right)),
    y: Math.round(clamp(expectedY, bounds.top, bounds.bottom)),
    score: 0,
  }
}

function inferProfileAnalysis(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
): ProfileAnalysis | undefined {
  const headBottom = bounds.top + bounds.height * 0.42
  let headLeft = bounds.right
  let headRight = bounds.left
  let headSumX = 0
  let headCount = 0
  for (let y = bounds.top; y <= Math.min(bounds.bottom, Math.ceil(headBottom)); y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (maskPoint(mask, x, y) === false) continue
      headLeft = Math.min(headLeft, x)
      headRight = Math.max(headRight, x)
      headSumX += x
      headCount += 1
    }
  }
  if (headCount === 0 || headRight - headLeft < 5) return undefined
  const headWidth = headRight - headLeft + 1
  const headHeight = headBottom - bounds.top + 1
  const headCenterX = headSumX / headCount
  const leftTip = profileTipCandidate(
    image, mask, bounds, -1, bounds.top, headBottom, headCenterX, headWidth,
  )
  const rightTip = profileTipCandidate(
    image, mask, bounds, 1, bounds.top, headBottom, headCenterX, headWidth,
  )
  const direction: -1 | 1 = rightTip.score >= leftTip.score ? 1 : -1
  const nose = direction === 1 ? rightTip : leftTip
  const opposite = direction === 1 ? leftTip : rightTip
  const forwardOffset = Math.abs(nose.x - headCenterX) / Math.max(1, headWidth)
  const directionalEvidence = clamp((nose.score - opposite.score) / 0.22, 0, 1)
  const profileEvidence = clamp((forwardOffset - 0.26) / 0.2, 0, 1) * 0.55
    + directionalEvidence * 0.45
  const subjectElongation = bounds.height / Math.max(1, bounds.width)
  const elongatedProfile = subjectElongation >= 1.12
    && profileEvidence >= 0.42
    && directionalEvidence >= 0.2
  const silhouetteProfile = forwardOffset >= 0.34
    && directionalEvidence >= 0.18
    && profileEvidence >= 0.5
  if (elongatedProfile === false && silhouetteProfile === false && profileEvidence < 0.78) return undefined

  const eyeExpectedX = nose.x - direction * headWidth * 0.3
  const eyeExpectedY = bounds.top + headHeight * 0.28
  const eye = refineEyeCenter(
    image,
    mask,
    profileFeature(image, mask, eyeExpectedX, eyeExpectedY, headWidth * 0.2, headHeight * 0.28),
    headWidth * 0.06,
  )
  const uprightEar = strongestPoint(image, mask, {
    left: headLeft,
    right: headRight,
    top: bounds.top,
    bottom: Math.min(bounds.bottom, Math.ceil(bounds.top + headHeight * 0.55)),
    width: headWidth,
    height: headHeight,
  }, (x, y) => {
    const behindEye = clamp(direction * (eye.x - x) / Math.max(1, headWidth * 0.42), 0, 1)
    const topness = clamp(1 - (y - bounds.top) / Math.max(1, headHeight * 0.58), 0, 1)
    const nearEye = clamp(1 - Math.abs(x - (eye.x - direction * headWidth * 0.12)) / Math.max(1, headWidth * 0.34), 0, 1)
    return topness * 0.58 + behindEye * 0.2 + nearEye * 0.22
  })
  const foldedEarExpectedX = eye.x - direction * headWidth * 0.2
  const foldedEarExpectedY = eye.y + headHeight * 0.05
  const foldedEar = strongestPoint(image, mask, {
    left: direction === 1 ? headLeft : Math.max(headLeft, Math.floor(eye.x + headWidth * 0.06)),
    right: direction === 1 ? Math.min(headRight, Math.ceil(eye.x - headWidth * 0.06)) : headRight,
    top: Math.max(bounds.top, Math.floor(eye.y - headHeight * 0.18)),
    bottom: Math.min(bounds.bottom, Math.ceil(eye.y + headHeight * 0.28)),
    width: headWidth,
    height: headHeight,
  }, (x, y) => {
    const distance = Math.hypot(
      (x - foldedEarExpectedX) / Math.max(1, headWidth * 0.22),
      (y - foldedEarExpectedY) / Math.max(1, headHeight * 0.22),
    )
    const behindEye = clamp(direction * (eye.x - x) / Math.max(1, headWidth * 0.4), 0, 1)
    return clamp(1 - distance, 0, 1) * 0.36
      + (1 - luminance(image, x, y)) * 0.24
      + localContrast(image, x, y, Math.max(1, Math.round(headWidth * 0.025))) * 0.22
      + behindEye * 0.18
  })
  const uprightRise = eye.y - uprightEar.y
  const ear = uprightRise >= headHeight * 0.12 ? uprightEar : foldedEar
  const earRoot = nearestMaskPoint(
    mask,
    bounds,
    ear.x + direction * headWidth * 0.08,
    ear.y + headHeight * 0.18,
    headWidth * 0.14,
    headHeight * 0.16,
  )
  const mouthExpectedX = eye.x + (nose.x - eye.x) * 0.72
  const mouthExpectedY = nose.y + headHeight * 0.08
  const mouth = profileFeature(
    image, mask, mouthExpectedX, mouthExpectedY, headWidth * 0.18, headHeight * 0.15,
  )
  const rawUpperJaw = profileBoundaryPoint(
    mask, bounds, direction, nose.y - headHeight * 0.06, headHeight * 0.08, headWidth * 0.05,
  )
  const rawLowerJaw = profileBoundaryPoint(
    mask, bounds, direction, nose.y + headHeight * 0.09, headHeight * 0.08, headWidth * 0.1,
  )
  const maximumJawRetreat = Math.max(2, headWidth * 0.06)
  const upperJaw = limitProfileRetreat(rawUpperJaw, nose, direction, maximumJawRetreat * 0.65)
  const lowerJawBase = limitProfileRetreat(rawLowerJaw, nose, direction, maximumJawRetreat)
  const lowerJaw = {
    ...lowerJawBase,
    y: Math.max(lowerJawBase.y, Math.round(upperJaw.y + Math.max(2, headHeight * 0.08))),
  }
  const confidence = Math.max(0.5, clamp(
    profileEvidence * 0.38 + nose.score * 0.2 + eye.score * 0.22 + mouth.score * 0.12 + ear.score * 0.08,
    0,
    1,
  ))
  return {
    pose: direction === 1 ? 'profile-right' : 'profile-left',
    direction,
    ear,
    earRoot,
    eye,
    nose,
    mouth,
    upperJaw,
    lowerJaw,
    headWidth,
    headHeight,
    confidence,
  }
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
  bounds: Bounds,
  centerX: number,
  faceWidth: number,
  earTop: number,
): readonly [PointScore, PointScore] {
  const expectedY = clamp(
    bounds.top + bounds.height * 0.42,
    earTop + faceWidth * 0.22,
    bounds.bottom,
  )
  const minimumY = Math.max(earTop + faceWidth * 0.16, bounds.top + bounds.height * 0.24)
  const maximumY = Math.min(bounds.bottom, bounds.top + bounds.height * 0.62)
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

function refineFrontalEyeCenter(
  image: PixelImage,
  mask: BinaryMask,
  point: PointScore,
  radius: number,
): PointScore {
  let localLightness = 0
  let localSamples = 0
  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0
  const integerRadius = Math.max(2, Math.round(radius))
  for (let y = Math.max(0, point.y - integerRadius); y <= Math.min(image.height - 1, point.y + integerRadius); y += 1) {
    for (let x = Math.max(0, point.x - integerRadius); x <= Math.min(image.width - 1, point.x + integerRadius); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(x - point.x, y - point.y) / integerRadius
      if (distance > 1) continue
      localLightness += luminance(image, x, y)
      localSamples += 1
    }
  }
  const localMean = localSamples === 0 ? luminance(image, point.x, point.y) : localLightness / localSamples
  for (let y = Math.max(0, point.y - integerRadius); y <= Math.min(image.height - 1, point.y + integerRadius); y += 1) {
    for (let x = Math.max(0, point.x - integerRadius); x <= Math.min(image.width - 1, point.x + integerRadius); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(x - point.x, y - point.y) / integerRadius
      if (distance > 1) continue
      const value = luminance(image, x, y)
      const relativeDarkness = clamp((localMean - value) / Math.max(0.12, localMean), 0, 1)
      const contrast = localContrast(image, x, y, Math.max(1, Math.round(integerRadius * 0.16)))
      const weight = relativeDarkness * relativeDarkness
        * (0.55 + contrast * 0.45)
        * Math.max(0, 1 - distance * distance)
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
  let best: PointScore = {
    x: clamp(Math.round(expectedX), 0, image.width - 1),
    y: clamp(Math.round(expectedY), 0, image.height - 1),
    score: 0,
  }
  for (let y = Math.max(0, Math.floor(expectedY - radius)); y <= Math.min(image.height - 1, Math.ceil(expectedY + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(expectedX - radius)); x <= Math.min(image.width - 1, Math.ceil(expectedX + radius)); x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      const distance = Math.hypot(x - expectedX, y - expectedY) / Math.max(1, radius)
      const score = redExcess(image, x, y) * 0.32
        + saturation(image, x, y) * 0.12
        + (1 - luminance(image, x, y)) * 0.12
        + localContrast(image, x, y, Math.max(1, Math.round(radius * 0.08))) * 0.28
        + clamp(1 - distance, 0, 1) * 0.16
      if (score > best.score) best = { x, y, score }
    }
  }
  return best
}

function frontalFaceAxis(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
  earCenter: number,
  faceWidth: number,
): number {
  const seed = noseFeature(
    image,
    mask,
    earCenter,
    bounds.top + bounds.height * 0.52,
    Math.max(faceWidth * 0.14, bounds.height * 0.12),
  )
  const plausibleOffset = Math.abs(seed.x - earCenter) <= faceWidth * 0.24
  return seed.score >= 0.34 && plausibleOffset
    ? earCenter * 0.35 + seed.x * 0.65
    : earCenter
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const ordered = [...values].sort((first, second) => first - second)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1
    ? ordered[middle]
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
}

function earTips(mask: BinaryMask, bounds: Bounds): readonly [PointScore, PointScore] | undefined {
  const centerX = (bounds.left + bounds.right) / 2
  const limitY = bounds.top + bounds.height * 0.38
  const topByX = new Map<number, number>()
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    for (let y = bounds.top; y <= limitY; y += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      topByX.set(x, y)
      break
    }
  }
  const prominenceRadius = Math.max(3, Math.round(bounds.width * 0.05))
  const candidates: PointScore[] = []
  for (const [x, y] of topByX) {
    const leftHeights: number[] = []
    const rightHeights: number[] = []
    for (let offset = 1; offset <= prominenceRadius; offset += 1) {
      const left = topByX.get(x - offset)
      const right = topByX.get(x + offset)
      if (left !== undefined) leftHeights.push(left)
      if (right !== undefined) rightHeights.push(right)
    }
    const leftMedian = median(leftHeights)
    const rightMedian = median(rightHeights)
    const surroundingHeight = leftMedian === undefined
      ? rightMedian
      : rightMedian === undefined
        ? leftMedian
        : (leftMedian + rightMedian) / 2
    const prominence = Math.max(0, (surroundingHeight ?? y) - y)
    const prominenceScore = clamp(prominence / Math.max(1, bounds.height * 0.16), 0, 1)
    const upperScore = 1 - (y - bounds.top) / Math.max(1, limitY - bounds.top)
    const lateralScore = clamp(Math.abs(x - centerX) / Math.max(1, bounds.width * 0.5), 0, 1)
    candidates.push({
      x,
      y,
      score: prominenceScore * 0.45 + upperScore * 0.2 + lateralScore * 0.35,
    })
  }
  let best: { left: PointScore, right: PointScore, score: number } | undefined
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!
      const separation = (right.x - left.x) / bounds.width
      if (separation < 0.2 || separation > 0.88) continue
      const separationScore = separation < 0.36
        ? clamp((separation - 0.2) / 0.16, 0, 1)
        : separation > 0.78
          ? clamp((0.88 - separation) / 0.1, 0, 1)
          : 1
      const pairCenter = (left.x + right.x) / 2
      const centerScore = clamp(1 - Math.abs(pairCenter - centerX) / Math.max(1, bounds.width * 0.42), 0, 1)
      const verticalScore = (left.score + right.score) / 2
      const heightCompatibility = clamp(1 - Math.abs(left.y - right.y) / Math.max(1, bounds.height * 0.28), 0, 1)
      const lateralCoverage = clamp((separation - 0.3) / 0.48, 0, 1)
      const score = verticalScore * 0.5
        + separationScore * 0.12
        + centerScore * 0.1
        + heightCompatibility * 0.1
        + lateralCoverage * 0.18
      if (best === undefined || score > best.score) best = { left, right, score }
    }
  }
  return best === undefined ? undefined : [best.left, best.right]
}

function hasStrongFrontalEvidence(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
): boolean {
  const ears = earTips(mask, bounds)
  if (ears === undefined) return false
  const [leftEar, rightEar] = ears
  const earSeparation = (rightEar.x - leftEar.x) / Math.max(1, bounds.width)
  const earCenter = (leftEar.x + rightEar.x) / 2
  const boundsCenter = (bounds.left + bounds.right) / 2
  const earCentering = clamp(
    1 - Math.abs(earCenter - boundsCenter) / Math.max(1, bounds.width * 0.18),
    0,
    1,
  )
  const earLevel = clamp(
    1 - Math.abs(leftEar.y - rightEar.y) / Math.max(1, bounds.height * 0.2),
    0,
    1,
  )
  const earHeight = Math.max(leftEar.y, rightEar.y) - bounds.top
  if (earSeparation < 0.32 || earSeparation > 0.88
    || earCentering < 0.45 || earLevel < 0.3 || earHeight > bounds.height * 0.26
    || leftEar.x > boundsCenter - bounds.width * 0.12
    || rightEar.x < boundsCenter + bounds.width * 0.12) return false

  const faceWidth = clamp(
    (rightEar.x - leftEar.x) * 1.55,
    bounds.width * 0.35,
    bounds.width * 0.82,
  )
  const faceAxisX = frontalFaceAxis(image, mask, bounds, earCenter, faceWidth)
  const [leftEye, rightEye] = eyePair(
    image,
    mask,
    bounds,
    faceAxisX,
    faceWidth,
    Math.min(leftEar.y, rightEar.y),
  )
  const eyeSeparation = (rightEye.x - leftEye.x) / Math.max(1, faceWidth)
  const eyeAlignment = clamp(
    1 - Math.abs(leftEye.y - rightEye.y) / Math.max(1, faceWidth * 0.18),
    0,
    1,
  )
  const eyeCenter = (leftEye.x + rightEye.x) / 2
  const eyeCentering = clamp(
    1 - Math.abs(eyeCenter - faceAxisX) / Math.max(1, faceWidth * 0.18),
    0,
    1,
  )
  const eyeEvidence = clamp((leftEye.score + rightEye.score) / 2, 0, 1)
  const eyeY = (leftEye.y + rightEye.y) / 2
  const eyeSpan = Math.max(1, rightEye.x - leftEye.x)
  const nose = noseFeature(
    image,
    mask,
    eyeCenter,
    eyeY + Math.max(faceWidth * 0.08, eyeSpan * 0.38),
    Math.max(faceWidth * 0.09, eyeSpan * 0.28),
  )
  const noseCentering = clamp(
    1 - Math.abs(nose.x - eyeCenter) / Math.max(1, faceWidth * 0.16),
    0,
    1,
  )
  const score = eyeEvidence * 0.34
    + eyeAlignment * 0.16
    + eyeCentering * 0.12
    + noseCentering * 0.18
    + earCentering * 0.1
    + earLevel * 0.1
  return eyeSeparation >= 0.16
    && eyeSeparation <= 0.58
    && eyeEvidence >= 0.3
    && eyeAlignment >= 0.45
    && noseCentering >= 0.42
    && score >= 0.55
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

function frontalFaceGeometry(
  bounds: Bounds,
  leftEye: PointScore,
  rightEye: PointScore,
  nose: PointScore,
  faceCenterX: number,
  eyeY: number,
  faceWidth: number,
): FrontalFaceGeometry {
  const eyeSpan = Math.max(1, rightEye.x - leftEye.x)
  const muzzleDepth = Math.max(1, nose.y - eyeY)
  const centerY = eyeY + Math.max(eyeSpan * 0.18, muzzleDepth * 0.35)
  const radiusX = clamp(
    Math.max(eyeSpan * 1.15, faceWidth * 0.32),
    faceWidth * 0.32,
    faceWidth * 0.38,
  )
  const chinY = clamp(
    nose.y + Math.max(eyeSpan * 0.5, muzzleDepth * 0.55, faceWidth * 0.1),
    nose.y,
    bounds.bottom,
  )
  const radiusY = Math.max(
    chinY - centerY,
    eyeSpan * 0.9,
    faceWidth * 0.28,
  )
  return {
    centerX: faceCenterX,
    centerY,
    radiusX,
    radiusY,
    chinY,
    earBaseY: eyeY - Math.max(eyeSpan * 0.38, faceWidth * 0.07),
    earHalfWidth: clamp(eyeSpan * 0.5, faceWidth * 0.11, faceWidth * 0.16),
    earOuterReach: Math.max(eyeSpan * 0.24, faceWidth * 0.06),
  }
}

function petFaceMask(
  subjectMask: BinaryMask,
  leftEar: PointScore,
  rightEar: PointScore,
  leftEye: PointScore,
  rightEye: PointScore,
  nose: PointScore,
  geometry: FrontalFaceGeometry,
): BinaryMask {
  const values = new Float32Array(subjectMask.values.length)
  const leftEarBase = [
    {
      x: Math.min(
        leftEye.x - geometry.earHalfWidth,
        leftEar.x - geometry.earOuterReach,
      ),
      y: geometry.earBaseY,
    },
    { x: leftEye.x + geometry.earHalfWidth, y: geometry.earBaseY },
  ] as const
  const rightEarBase = [
    { x: rightEye.x - geometry.earHalfWidth, y: geometry.earBaseY },
    {
      x: Math.max(
        rightEye.x + geometry.earHalfWidth,
        rightEar.x + geometry.earOuterReach,
      ),
      y: geometry.earBaseY,
    },
  ] as const
  for (let y = 0; y < subjectMask.height; y += 1) {
    for (let x = 0; x < subjectMask.width; x += 1) {
      const index = y * subjectMask.width + x
      const subjectValue = subjectMask.values[index] ?? 0
      if (subjectValue <= 0) continue
      const ellipse = ((x - geometry.centerX) / geometry.radiusX) ** 2
        + ((y - geometry.centerY) / geometry.radiusY) ** 2 <= 1
      const leftTriangle = pointInTriangle(x, y, leftEar, leftEarBase[0], leftEarBase[1])
      const rightTriangle = pointInTriangle(x, y, rightEar, rightEarBase[0], rightEarBase[1])
      if (ellipse || leftTriangle || rightTriangle) values[index] = subjectValue
    }
  }
  for (const feature of [leftEar, rightEar, leftEye, rightEye, nose]) {
    const x = Math.round(feature.x)
    const y = Math.round(feature.y)
    if (maskPoint(subjectMask, x, y)) {
      const index = y * subjectMask.width + x
      values[index] = subjectMask.values[index] ?? 1
    }
  }
  return { width: subjectMask.width, height: subjectMask.height, values }
}

function distanceToSegment(
  x: number,
  y: number,
  start: { x: number, y: number },
  end: { x: number, y: number },
): number {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (lengthSquared <= 1e-8) return Math.hypot(x - start.x, y - start.y)
  const position = clamp(((x - start.x) * deltaX + (y - start.y) * deltaY) / lengthSquared, 0, 1)
  return Math.hypot(x - (start.x + deltaX * position), y - (start.y + deltaY * position))
}

function profileFaceMask(subjectMask: BinaryMask, profile: ProfileAnalysis): BinaryMask {
  const values = new Float32Array(subjectMask.values.length)
  const headCenter = {
    x: profile.eye.x - profile.direction * profile.headWidth * 0.08,
    y: profile.eye.y + profile.headHeight * 0.08,
  }
  const radiusX = profile.headWidth * 0.38
  const radiusY = profile.headHeight * 0.38
  const muzzleRadius = Math.max(1, profile.headHeight * 0.14)
  const earBase = {
    x: profile.eye.x - profile.direction * profile.headWidth * 0.12,
    y: profile.eye.y - profile.headHeight * 0.06,
  }
  const earHalfWidth = profile.headWidth * 0.12
  const earBaseFirst = { x: earBase.x - earHalfWidth, y: earBase.y }
  const earBaseSecond = { x: earBase.x + earHalfWidth, y: earBase.y }
  for (let y = 0; y < subjectMask.height; y += 1) {
    for (let x = 0; x < subjectMask.width; x += 1) {
      const index = y * subjectMask.width + x
      const subjectValue = subjectMask.values[index] ?? 0
      if (subjectValue <= 0) continue
      const head = ((x - headCenter.x) / radiusX) ** 2 + ((y - headCenter.y) / radiusY) ** 2 <= 1
      const muzzle = distanceToSegment(x, y, profile.eye, profile.nose) <= muzzleRadius
      const ear = pointInTriangle(x, y, profile.ear, earBaseFirst, earBaseSecond)
      if (head || muzzle || ear) values[index] = subjectValue
    }
  }
  return { width: subjectMask.width, height: subjectMask.height, values }
}

function profileBodyEvidence(
  subjectMask: BinaryMask,
  faceMask: BinaryMask,
  bounds: Bounds,
  profile: ProfileAnalysis,
): number {
  let subjectCells = 0
  let bodyCells = 0
  let bodyLeft = bounds.right
  let bodyRight = bounds.left
  let bodyTop = bounds.bottom
  let bodyBottom = bounds.top
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const index = y * subjectMask.width + x
      if ((subjectMask.values[index] ?? 0) < 0.5) continue
      subjectCells += 1
      if ((faceMask.values[index] ?? 0) >= 0.5) continue
      bodyCells += 1
      bodyLeft = Math.min(bodyLeft, x)
      bodyRight = Math.max(bodyRight, x)
      bodyTop = Math.min(bodyTop, y)
      bodyBottom = Math.max(bodyBottom, y)
    }
  }
  if (bodyCells === 0 || subjectCells === 0) return 0

  const bodyWidth = bodyRight - bodyLeft + 1
  const bodyHeight = bodyBottom - bodyTop + 1
  const bodyWidthRatio = bodyWidth / Math.max(1, profile.headWidth)
  const bodyHeightRatio = bodyHeight / Math.max(1, profile.headHeight)
  const bodyMassRatio = bodyCells / subjectCells
  const backwardReach = profile.direction === 1
    ? profile.eye.x - bodyLeft
    : bodyRight - profile.eye.x
  const backwardRatio = backwardReach / Math.max(1, profile.headWidth)
  const minimumRun = Math.max(2, Math.round(bounds.width * 0.045))
  let maximumLowerRuns = 0
  const lowerStart = Math.floor(bounds.top + bounds.height * 0.76)
  for (let y = lowerStart; y <= bounds.bottom; y += 1) {
    let runs = 0
    let runLength = 0
    for (let x = bounds.left; x <= bounds.right + 1; x += 1) {
      const occupied = x <= bounds.right
        && (subjectMask.values[y * subjectMask.width + x] ?? 0) >= 0.5
        && (faceMask.values[y * faceMask.width + x] ?? 0) < 0.5
      if (occupied) {
        runLength += 1
      } else {
        if (runLength >= minimumRun) runs += 1
        runLength = 0
      }
    }
    maximumLowerRuns = Math.max(maximumLowerRuns, runs)
  }

  const widthEvidence = clamp((bodyWidthRatio - 0.42) / 0.48, 0, 1)
  const heightEvidence = clamp((bodyHeightRatio - 0.42) / 0.58, 0, 1)
  const massEvidence = clamp((bodyMassRatio - 0.18) / 0.32, 0, 1)
  const backwardEvidence = clamp((backwardRatio - 0.45) / 0.5, 0, 1)
  const legEvidence = clamp((maximumLowerRuns - 1) / 1.5, 0, 1)
  const evidence = clamp(
    widthEvidence * 0.24
      + heightEvidence * 0.16
      + massEvidence * 0.18
      + backwardEvidence * 0.2
      + legEvidence * 0.22,
    0,
    1,
  )
  const hasSeparatedSupports = maximumLowerRuns >= 2
  const hasBroadRearBody = bodyWidthRatio >= 0.88
    && backwardRatio >= 0.68
    && bodyMassRatio >= 0.32
  return hasSeparatedSupports || hasBroadRearBody ? evidence : evidence * 0.35
}

function frontalBodyEvidence(
  subjectMask: BinaryMask,
  faceMask: BinaryMask,
  bounds: Bounds,
  faceGeometry: FrontalFaceGeometry,
): FrontalBodyEvidence {
  let subjectCells = 0
  let bodyCells = 0
  let belowFaceCells = 0
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const index = y * subjectMask.width + x
      if ((subjectMask.values[index] ?? 0) < 0.5) continue
      subjectCells += 1
      if (y > faceGeometry.chinY) belowFaceCells += 1
      if ((faceMask.values[index] ?? 0) < 0.5) bodyCells += 1
    }
  }
  if (subjectCells === 0) {
    return {
      available: false,
      bodyMassRatio: 0,
      belowFaceMassRatio: 0,
      lowerExtensionRatio: 0,
      lowerSupportRuns: 0,
      lowerSupportRows: 0,
      confidence: 0,
    }
  }

  const bodyMassRatio = bodyCells / subjectCells
  const belowFaceMassRatio = belowFaceCells / subjectCells
  const lowerExtensionRatio = clamp(
    (bounds.bottom - faceGeometry.chinY) / Math.max(1, bounds.height),
    0,
    1,
  )
  const minimumRun = Math.max(2, Math.round(bounds.width * 0.06))
  const lowerStart = Math.max(
    Math.ceil(faceGeometry.chinY + Math.max(2, faceGeometry.radiusY * 0.08)),
    Math.floor(bounds.top + bounds.height * 0.72),
  )
  let lowerSupportRuns = 0
  let lowerSupportRows = 0
  for (let y = lowerStart; y <= bounds.bottom; y += 1) {
    let runs = 0
    let runLength = 0
    for (let x = bounds.left; x <= bounds.right + 1; x += 1) {
      const index = y * subjectMask.width + x
      const occupied = x <= bounds.right
        && (subjectMask.values[index] ?? 0) >= 0.5
        && (faceMask.values[index] ?? 0) < 0.5
      if (occupied) {
        runLength += 1
      } else {
        if (runLength >= minimumRun) runs += 1
        runLength = 0
      }
    }
    lowerSupportRuns = Math.max(lowerSupportRuns, runs)
    if (runs >= 2) lowerSupportRows += 1
  }
  const sampledLowerRows = Math.max(1, bounds.bottom - lowerStart + 1)
  const hasSeparatedSupports = lowerSupportRuns >= 2
    && lowerSupportRows >= Math.max(2, Math.round(sampledLowerRows * 0.22))
  const hasLongTorso = lowerExtensionRatio >= 0.34
    && belowFaceMassRatio >= 0.16
    && bodyMassRatio >= 0.45
  const hasDominantBody = bodyMassRatio >= 0.68
    && belowFaceMassRatio >= 0.11
    && lowerExtensionRatio >= 0.22
  const available = hasSeparatedSupports || hasLongTorso || hasDominantBody
  const confidence = clamp(
    bodyMassRatio * 0.38
      + belowFaceMassRatio * 0.32
      + lowerExtensionRatio * 0.3,
    0,
    1,
  )
  return {
    available,
    bodyMassRatio,
    belowFaceMassRatio,
    lowerExtensionRatio,
    lowerSupportRuns,
    lowerSupportRows,
    confidence,
  }
}

function frontalBodyRegion(
  subjectMask: BinaryMask,
  faceMask: BinaryMask,
  confidence: number,
): SemanticRegion {
  const values = new Float32Array(subjectMask.values.length)
  for (let index = 0; index < values.length; index += 1) {
    const subjectValue = subjectMask.values[index] ?? 0
    if (subjectValue < 0.5 || (faceMask.values[index] ?? 0) >= 0.5) continue
    values[index] = subjectValue
  }
  return {
    id: 'pet-body',
    label: 'pet body',
    mask: { width: subjectMask.width, height: subjectMask.height, values },
    confidence: clamp(confidence, 0, 1),
    importance: 0.84,
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-body-v3-frontal-evidence' }],
  }
}

function cropAroundBounds(
  image: PixelImage,
  bounds: Bounds,
  marginRatio: number,
  minimumMargin = 2,
): CropRect {
  const margin = Math.max(minimumMargin, Math.round(Math.max(bounds.width, bounds.height) * marginRatio))
  const left = clamp(bounds.left - margin, 0, image.width - 1)
  const top = clamp(bounds.top - margin, 0, image.height - 1)
  const right = clamp(bounds.right + margin + 1, left + 1, image.width)
  const bottom = clamp(bounds.bottom + margin + 1, top + 1, image.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function cropAroundMaskAndPoints(
  image: PixelImage,
  mask: BinaryMask,
  points: readonly { x: number, y: number }[],
  marginRatio: number,
): CropRect {
  const activeBounds = maskBounds(mask)
  let left = activeBounds?.left ?? image.width - 1
  let top = activeBounds?.top ?? image.height - 1
  let right = activeBounds?.right ?? 0
  let bottom = activeBounds?.bottom ?? 0
  for (const point of points) {
    left = Math.min(left, Math.floor(point.x))
    top = Math.min(top, Math.floor(point.y))
    right = Math.max(right, Math.ceil(point.x))
    bottom = Math.max(bottom, Math.ceil(point.y))
  }
  return cropAroundBounds(image, {
    left: clamp(left, 0, image.width - 1),
    top: clamp(top, 0, image.height - 1),
    right: clamp(right, 0, image.width - 1),
    bottom: clamp(bottom, 0, image.height - 1),
    width: right - left + 1,
    height: bottom - top + 1,
  }, marginRatio, 1)
}

function nearestMaskPoint(
  mask: BinaryMask,
  bounds: Bounds,
  expectedX: number,
  expectedY: number,
  radiusX: number,
  radiusY: number,
): PointScore {
  let best: PointScore | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (maskPoint(mask, x, y) === false) continue
      const distance = Math.hypot(
        (x - expectedX) / Math.max(1, radiusX),
        (y - expectedY) / Math.max(1, radiusY),
      )
      if (distance < bestDistance) {
        bestDistance = distance
        best = { x, y, score: 1 / (1 + distance) }
      }
    }
  }
  return best ?? {
    x: Math.round(clamp(expectedX, bounds.left, bounds.right)),
    y: Math.round(clamp(expectedY, bounds.top, bounds.bottom)),
    score: 0,
  }
}

function profileBodyStructure(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
  direction: -1 | 1,
): ProfileBodyAnalysis {
  const centerX = (bounds.left + bounds.right) / 2
  const lowerBody: Bounds = {
    left: bounds.left,
    right: bounds.right,
    top: Math.floor(bounds.top + bounds.height * 0.48),
    bottom: bounds.bottom,
    width: bounds.width,
    height: Math.max(1, Math.ceil(bounds.height * 0.52)),
  }
  const frontBand: Bounds = {
    ...lowerBody,
    left: direction === 1 ? Math.floor(centerX) : bounds.left,
    right: direction === 1 ? bounds.right : Math.ceil(centerX),
  }
  const rearBand: Bounds = {
    ...lowerBody,
    left: direction === 1 ? bounds.left : Math.floor(centerX),
    right: direction === 1 ? Math.ceil(centerX) : bounds.right,
  }
  const bottomness = (y: number) => clamp(
    (y - lowerBody.top) / Math.max(1, lowerBody.bottom - lowerBody.top),
    0,
    1,
  )
  const forwardness = (x: number) => clamp(
    direction * (x - centerX) / Math.max(1, bounds.width * 0.5),
    0,
    1,
  )
  const backwardness = (x: number) => clamp(
    direction * (centerX - x) / Math.max(1, bounds.width * 0.5),
    0,
    1,
  )
  const tail = strongestPoint(image, mask, lowerBody, (x, y) =>
    backwardness(x) * 0.72
      + clamp(1 - Math.abs(y - (bounds.top + bounds.height * 0.72)) / Math.max(1, bounds.height * 0.3), 0, 1) * 0.28)
  const frontPaw = strongestPoint(image, mask, frontBand, (x, y) =>
    bottomness(y) * 0.78 + forwardness(x) * 0.22)
  const rearPaw = strongestPoint(image, mask, rearBand, (x, y) =>
    bottomness(y) * 0.82 + backwardness(x) * 0.18)
  const at = (x: number, y: number, radiusX = 0.2, radiusY = 0.16) => nearestMaskPoint(
    mask,
    bounds,
    x,
    y,
    bounds.width * radiusX,
    bounds.height * radiusY,
  )
  const neck = at(
    centerX + direction * bounds.width * 0.18,
    bounds.top + bounds.height * 0.4,
    0.16,
    0.12,
  )
  const shoulder = at(
    centerX + direction * bounds.width * 0.22,
    bounds.top + bounds.height * 0.5,
    0.18,
    0.13,
  )
  const chest = at(
    centerX + direction * bounds.width * 0.25,
    bounds.top + bounds.height * 0.64,
    0.18,
    0.14,
  )
  const back = at(
    centerX - direction * bounds.width * 0.05,
    bounds.top + bounds.height * 0.43,
    0.2,
    0.12,
  )
  const tailRoot = at(
    centerX - direction * bounds.width * 0.23,
    bounds.top + bounds.height * 0.7,
    0.17,
    0.15,
  )
  const hip = at(
    centerX - direction * bounds.width * 0.17,
    bounds.top + bounds.height * 0.68,
    0.18,
    0.14,
  )
  const frontKnee = at(
    shoulder.x * 0.42 + frontPaw.x * 0.58,
    shoulder.y * 0.42 + frontPaw.y * 0.58,
    0.12,
    0.12,
  )
  const rearKnee = at(
    hip.x * 0.5 + rearPaw.x * 0.5,
    hip.y * 0.5 + rearPaw.y * 0.5,
    0.14,
    0.12,
  )
  return {
    neck,
    shoulder,
    chest,
    back,
    tailRoot,
    hip,
    frontKnee,
    frontPaw,
    rearKnee,
    rearPaw,
    tail,
  }
}

function polylineDistance(
  x: number,
  y: number,
  points: readonly { x: number, y: number }[],
): number {
  let distance = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(x, y, points[index - 1]!, points[index]!))
  }
  return distance
}

function proximity(distance: number, radius: number): number {
  const normalized = distance / Math.max(1, radius)
  return 1 / (1 + normalized * normalized)
}

function profileBodyRegions(
  subjectMask: BinaryMask,
  faceMask: BinaryMask,
  bounds: Bounds,
  direction: -1 | 1,
  body: ProfileBodyAnalysis,
  confidence: number,
): readonly SemanticRegion[] {
  const definitions = [
    { id: 'pet-neck', label: 'pet neck', importance: 0.92 },
    { id: 'pet-thorax', label: 'pet thorax', importance: 0.9 },
    { id: 'pet-haunch', label: 'pet haunch', importance: 0.86 },
    { id: 'pet-foreleg-visible', label: 'pet visible foreleg', importance: 0.96 },
    { id: 'pet-hindleg-visible', label: 'pet visible hindleg', importance: 0.9 },
    { id: 'pet-tail', label: 'pet tail', importance: 0.94 },
  ] as const
  const masks = definitions.map(() => new Float32Array(subjectMask.values.length))
  const centerX = (bounds.left + bounds.right) / 2
  const forwardness = (x: number) => clamp(
    direction * (x - centerX) / Math.max(1, bounds.width * 0.5),
    0,
    1,
  )
  const backwardness = (x: number) => clamp(
    direction * (centerX - x) / Math.max(1, bounds.width * 0.5),
    0,
    1,
  )
  const lowerness = (y: number) => clamp(
    (y - bounds.top) / Math.max(1, bounds.height),
    0,
    1,
  )
  const scale = Math.max(1, bounds.width)
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const sourceIndex = y * subjectMask.width + x
      const support = subjectMask.values[sourceIndex] ?? 0
      if (support < 0.5 || (faceMask.values[sourceIndex] ?? 0) >= 0.5) continue
      const scores = [
        proximity(polylineDistance(x, y, [body.neck, body.shoulder]), scale * 0.1) * 1.15
          + forwardness(x) * 0.08 + (1 - lowerness(y)) * 0.08,
        Math.max(
          proximity(polylineDistance(x, y, [body.back, body.shoulder, body.chest]), scale * 0.2),
          proximity(distanceToSegment(x, y, body.shoulder, body.chest), scale * 0.16),
        ) + forwardness(x) * 0.05,
        Math.max(
          proximity(polylineDistance(x, y, [body.back, body.tailRoot, body.hip]), scale * 0.21),
          proximity(distanceToSegment(x, y, body.tailRoot, body.hip), scale * 0.16),
        ) + backwardness(x) * 0.08,
        proximity(
          polylineDistance(x, y, [body.shoulder, body.frontKnee, body.frontPaw]),
          scale * 0.075,
        ) * 1.18 + lowerness(y) * 0.12 + forwardness(x) * 0.08,
        proximity(
          polylineDistance(x, y, [body.hip, body.rearKnee, body.rearPaw]),
          scale * 0.095,
        ) * 1.12 + lowerness(y) * 0.1 + backwardness(x) * 0.05,
        proximity(distanceToSegment(x, y, body.tailRoot, body.tail), scale * 0.065) * 1.25
          + backwardness(x) * 0.14,
      ]
      let selected = 0
      for (let index = 1; index < scores.length; index += 1) {
        if (scores[index]! > scores[selected]!) selected = index
      }
      masks[selected]![sourceIndex] = support
    }
  }
  return definitions.map((definition, index) => ({
    ...definition,
    confidence: clamp(confidence * (definition.id.includes('leg') ? 0.88 : 0.94), 0, 1),
    mask: { width: subjectMask.width, height: subjectMask.height, values: masks[index]! },
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-body-v2-animalpose-schema' }],
  }))
}

function landmark(
  id: string,
  kind: ImageLandmark['kind'],
  point: { x: number, y: number },
  confidence: number,
  options: Partial<ImageLandmark> = {},
): ImageLandmark {
  const resolvedConfidence = clamp(confidence, 0, 1)
  return {
    id,
    kind,
    x: point.x,
    y: point.y,
    confidence: resolvedConfidence,
    priority: kind === 'face-contour' ? 'soft' : 'hard',
    sourceRadiusPx: kind === 'eye' ? 3 : kind === 'nose' ? 2 : 1,
    gridRadiusCells: kind === 'eye' ? 1 : 0.5,
    carrierRegionId: 'pet-face',
    observationState: resolvedConfidence >= 0.6
      ? 'observed'
      : resolvedConfidence >= 0.2
        ? 'inferred'
        : 'missing',
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v3-animalpose-schema' }],
    ...options,
  }
}

function inferSinglePetAnalysis(image: PixelImage, mask: BinaryMask): PetAnalysisResult | undefined {
  validate(image, mask)
  const analysisMask = principalComponentMask(mask)
  const bounds = maskBounds(analysisMask)
  if (bounds === undefined || bounds.width < 6 || bounds.height < 6) return undefined
  if (flatGeometricNegativeEvidence(image, analysisMask, bounds) >= 0.96) return undefined
  const profile = hasStrongFrontalEvidence(image, analysisMask, bounds)
    ? undefined
    : inferProfileAnalysis(image, analysisMask, bounds)
  if (profile !== undefined) {
    const crop = cropAroundBounds(image, bounds, 0.08)
    const faceMask = profileFaceMask(analysisMask, profile)
    const bodyAvailable = profileBodyEvidence(analysisMask, faceMask, bounds, profile) >= 0.58
    const body = bodyAvailable
      ? profileBodyStructure(image, analysisMask, bounds, profile.direction)
      : undefined
    const bodyRegions = body === undefined
      ? []
      : profileBodyRegions(
          analysisMask,
          faceMask,
          bounds,
          profile.direction,
          body,
          profile.confidence,
        )
    const bodyLandmarkOptions: Partial<ImageLandmark> = {
      priority: 'soft',
      sourceRadiusPx: 2,
      gridRadiusCells: 0.5,
      carrierRegionId: 'subject',
      affectsOccupancy: true,
      observationState: 'inferred',
    }
    const structuralLandmark = (
      id: string,
      point: PointScore,
      structuralRole: NonNullable<ImageLandmark['structuralRole']>,
      carrierRegionId: string,
      confidenceScale: number,
      priority: ImageLandmark['priority'] = 'soft',
      observationState: ImageLandmark['observationState'] = 'inferred',
    ) => landmark(id, 'body', point, profile.confidence * confidenceScale, {
      ...bodyLandmarkOptions,
      priority,
      structuralRole,
      carrierRegionId,
      observationState,
    })
    const landmarks: ImageLandmark[] = [
      landmark('visible-ear-tip', 'ear', profile.ear, profile.confidence, {
        affectsOccupancy: true,
        structuralRole: 'ear-tip',
      }),
      structuralLandmark(
        'visible-ear-root',
        profile.earRoot,
        'ear-root',
        'pet-face',
        1,
        'hard',
        profile.confidence >= 0.6 ? 'observed' : 'inferred',
      ),
      landmark('visible-eye-center', 'eye', profile.eye, profile.eye.score, {
        gridRadiusCells: 0,
        structuralRole: 'eye-center',
      }),
      landmark('nose-tip', 'nose', profile.nose, profile.nose.score, {
        affectsOccupancy: true,
        structuralRole: 'nose-tip',
      }),
      landmark('mouth-corner', 'mouth', profile.mouth, profile.mouth.score, {
        structuralRole: 'mouth-corner',
      }),
      landmark('upper-jaw-end', 'face-contour', profile.upperJaw, profile.confidence, {
        affectsOccupancy: true,
        priority: 'hard',
        structuralRole: 'upper-jaw',
        gridRadiusCells: 0,
      }),
      landmark('lower-jaw-end', 'face-contour', profile.lowerJaw, profile.confidence, {
        affectsOccupancy: true,
        priority: 'hard',
        structuralRole: 'lower-jaw',
        gridRadiusCells: 0,
      }),
    ]
    if (body !== undefined) {
      landmarks.push(
        structuralLandmark('neck-base', body.neck, 'neck-base', 'pet-neck', 1, 'hard'),
        structuralLandmark('visible-shoulder', body.shoulder, 'shoulder', 'pet-thorax', 1, 'hard'),
        structuralLandmark('chest-center', body.chest, 'chest-center', 'pet-thorax', 0.88),
        structuralLandmark('back-middle', body.back, 'back-middle', 'pet-thorax', 0.86),
        structuralLandmark('tail-root', body.tailRoot, 'tail-root', 'pet-haunch', 1, 'hard'),
        structuralLandmark('visible-hip', body.hip, 'hip', 'pet-haunch', 0.9),
        structuralLandmark('front-knee', body.frontKnee, 'front-knee', 'pet-foreleg-visible', 0.82),
        structuralLandmark('front-paw', body.frontPaw, 'front-paw', 'pet-foreleg-visible', 0.88),
        structuralLandmark('rear-knee', body.rearKnee, 'rear-knee', 'pet-hindleg-visible', 0.8),
        structuralLandmark('rear-paw', body.rearPaw, 'rear-paw', 'pet-hindleg-visible', 0.88),
        structuralLandmark('tail-tip', body.tail, 'tail-tip', 'pet-tail', 0.86),
      )
    }
    return {
      imageType: 'pet',
      headPose: profile.pose,
      landmarks,
      faceMask,
      bodyRegions,
      suggestedCrop: crop,
      suggestedCropConfidence: profile.confidence,
      confidence: profile.confidence,
    }
  }
  const ears = earTips(analysisMask, bounds)
  if (ears === undefined) return undefined
  const [leftEar, rightEar] = ears
  const earSeparation = rightEar.x - leftEar.x
  if (earSeparation < bounds.width * 0.18) return undefined
  const centerX = (leftEar.x + rightEar.x) / 2
  const faceWidth = clamp(earSeparation * 1.55, bounds.width * 0.35, bounds.width * 0.82)
  const earTop = Math.min(leftEar.y, rightEar.y)
  const faceAxisX = frontalFaceAxis(image, analysisMask, bounds, centerX, faceWidth)
  const [rawLeftEye, rawRightEye] = eyePair(
    image,
    analysisMask,
    bounds,
    faceAxisX,
    faceWidth,
    earTop,
  )
  const leftEye = refineFrontalEyeCenter(image, analysisMask, rawLeftEye, faceWidth * 0.07)
  const rightEye = refineFrontalEyeCenter(image, analysisMask, rawRightEye, faceWidth * 0.07)
  const eyeY = (leftEye.y + rightEye.y) / 2
  const eyeMidpointX = (leftEye.x + rightEye.x) / 2
  const eyeSpan = Math.max(1, rightEye.x - leftEye.x)
  const nose = noseFeature(
    image,
    analysisMask,
    eyeMidpointX,
    eyeY + Math.max(faceWidth * 0.08, eyeSpan * 0.38),
    Math.max(faceWidth * 0.09, eyeSpan * 0.28),
  )
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
  const faceGeometry = frontalFaceGeometry(
    bounds,
    leftEye,
    rightEye,
    nose,
    faceCenterX,
    eyeY,
    faceWidth,
  )
  const faceLeft = {
    x: clamp(faceCenterX - faceGeometry.radiusX, bounds.left, bounds.right),
    y: faceGeometry.centerY,
  }
  const faceRight = {
    x: clamp(faceCenterX + faceGeometry.radiusX, bounds.left, bounds.right),
    y: faceGeometry.centerY,
  }
  const chin = { x: faceCenterX, y: faceGeometry.chinY }
  const mouthY = clamp(
    nose.y + Math.max(2, eyeSpan * 0.42),
    nose.y + 1,
    faceGeometry.chinY,
  )
  const mouthHalfSpan = Math.max(1, eyeSpan * 0.28)
  const leftMouth = nearestMaskPoint(
    analysisMask,
    bounds,
    nose.x - mouthHalfSpan,
    mouthY,
    Math.max(2, eyeSpan * 0.22),
    Math.max(2, faceGeometry.radiusY * 0.12),
  )
  const rightMouth = nearestMaskPoint(
    analysisMask,
    bounds,
    nose.x + mouthHalfSpan,
    mouthY,
    Math.max(2, eyeSpan * 0.22),
    Math.max(2, faceGeometry.radiusY * 0.12),
  )
  const landmarks = [
    landmark('left-ear-tip', 'ear', leftEar, confidence, { symmetryGroup: 'ears', affectsOccupancy: true }),
    landmark('right-ear-tip', 'ear', rightEar, confidence, { symmetryGroup: 'ears', affectsOccupancy: true }),
    landmark('left-eye-center', 'eye', leftEye, leftEye.score, { symmetryGroup: 'eyes' }),
    landmark('right-eye-center', 'eye', rightEye, rightEye.score, { symmetryGroup: 'eyes' }),
    landmark('nose-tip', 'nose', nose, nose.score),
    landmark('left-mouth-corner', 'mouth', leftMouth, confidence * 0.82, {
      symmetryGroup: 'mouth-corners',
      structuralRole: 'mouth-corner',
      priority: 'soft',
      observationState: 'inferred',
    }),
    landmark('right-mouth-corner', 'mouth', rightMouth, confidence * 0.82, {
      symmetryGroup: 'mouth-corners',
      structuralRole: 'mouth-corner',
      priority: 'soft',
      observationState: 'inferred',
    }),
    landmark('face-left', 'face-contour', faceLeft, confidence, { symmetryGroup: 'face-sides', affectsOccupancy: true }),
    landmark('face-right', 'face-contour', faceRight, confidence, { symmetryGroup: 'face-sides', affectsOccupancy: true }),
    landmark('chin', 'face-contour', chin, confidence, { affectsOccupancy: true }),
  ]
  const faceMask = petFaceMask(
    analysisMask,
    leftEar,
    rightEar,
    leftEye,
    rightEye,
    nose,
    faceGeometry,
  )
  const leftEarRoot = nearestMaskPoint(
    analysisMask,
    bounds,
    leftEye.x - faceGeometry.earHalfWidth * 0.35,
    faceGeometry.earBaseY,
    faceGeometry.earHalfWidth,
    Math.max(2, faceGeometry.radiusY * 0.16),
  )
  const rightEarRoot = nearestMaskPoint(
    analysisMask,
    bounds,
    rightEye.x + faceGeometry.earHalfWidth * 0.35,
    faceGeometry.earBaseY,
    faceGeometry.earHalfWidth,
    Math.max(2, faceGeometry.radiusY * 0.16),
  )
  landmarks[0] = landmark('left-ear-tip', 'ear', leftEar, confidence, {
    symmetryGroup: 'ears',
    affectsOccupancy: true,
    structuralRole: 'ear-tip',
    gridRadiusCells: 0,
  })
  landmarks[1] = landmark('right-ear-tip', 'ear', rightEar, confidence, {
    symmetryGroup: 'ears',
    affectsOccupancy: true,
    structuralRole: 'ear-tip',
    gridRadiusCells: 0,
  })
  landmarks[2] = landmark('left-eye-center', 'eye', leftEye, leftEye.score, {
    symmetryGroup: 'eyes',
    structuralRole: 'eye-center',
  })
  landmarks[3] = landmark('right-eye-center', 'eye', rightEye, rightEye.score, {
    symmetryGroup: 'eyes',
    structuralRole: 'eye-center',
  })
  landmarks[4] = landmark('nose-tip', 'nose', nose, nose.score, {
    structuralRole: 'nose-tip',
  })
  landmarks.push(
    landmark('left-ear-root', 'body', leftEarRoot, confidence, {
      symmetryGroup: 'ear-roots',
      structuralRole: 'ear-root',
      priority: 'soft',
      observationState: 'inferred',
    }),
    landmark('right-ear-root', 'body', rightEarRoot, confidence, {
      symmetryGroup: 'ear-roots',
      structuralRole: 'ear-root',
      priority: 'soft',
      observationState: 'inferred',
    }),
  )
  const bodyEvidence = frontalBodyEvidence(analysisMask, faceMask, bounds, faceGeometry)
  const bodyRegions = bodyEvidence.available
    ? [frontalBodyRegion(analysisMask, faceMask, Math.max(confidence * 0.78, bodyEvidence.confidence))]
    : []
  const crop = bodyEvidence.available
    ? cropAroundBounds(image, bounds, 0.08)
    : cropAroundMaskAndPoints(image, faceMask, landmarks, 0.08)
  return {
    imageType: 'pet',
    headPose: 'frontal',
    landmarks,
    faceMask,
    bodyRegions,
    suggestedCrop: crop,
    suggestedCropConfidence: confidence,
    confidence,
    frontalBodyEvidence: bodyEvidence,
  }
}

function prefixedPetAnalysis(
  analysis: PetAnalysisResult,
  instanceId: string,
): PetAnalysisResult {
  const regionId = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : `${instanceId}:${value}`
  return {
    ...analysis,
    landmarks: analysis.landmarks.map((landmark) => {
      const featureRegionId = regionId(landmark.featureRegionId)
      const carrierRegionId = regionId(landmark.carrierRegionId)
      return {
        ...landmark,
        id: `${instanceId}:${landmark.id}`,
        ...(landmark.symmetryGroup === undefined
          ? {}
          : { symmetryGroup: `${instanceId}:${landmark.symmetryGroup}` }),
        ...(featureRegionId === undefined ? {} : { featureRegionId }),
        ...(carrierRegionId === undefined ? {} : { carrierRegionId }),
      }
    }),
    bodyRegions: analysis.bodyRegions.map((region) => ({
      ...region,
      id: `${instanceId}:${region.id}`,
    })),
  }
}

function combinedMask(masks: readonly BinaryMask[]): BinaryMask {
  const first = masks[0]!
  const values = new Float32Array(first.values.length)
  for (const mask of masks) {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.max(values[index] ?? 0, mask.values[index] ?? 0)
    }
  }
  return { width: first.width, height: first.height, values }
}

function combinedCrop(image: PixelImage, crops: readonly CropRect[]): CropRect {
  const left = Math.max(0, Math.min(...crops.map((crop) => crop.x)))
  const top = Math.max(0, Math.min(...crops.map((crop) => crop.y)))
  const right = Math.min(image.width, Math.max(...crops.map((crop) => crop.x + crop.width)))
  const bottom = Math.min(image.height, Math.max(...crops.map((crop) => crop.y + crop.height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function inferPetInstances(
  image: PixelImage,
  mask: BinaryMask,
): PetInstanceGroupAnalysis | undefined {
  validate(image, mask)
  const components = connectedMaskComponents(mask)
  const primaryArea = components[0]?.indices.length ?? 0
  const imageArea = image.width * image.height
  const retained = components.flatMap((component, index) => {
    const sourceArea = component.indices.length
    const relativeArea = primaryArea === 0 ? 0 : sourceArea / primaryArea
    const imageCoverage = sourceArea / imageArea
    if (index > 0 && (relativeArea < 0.12 || imageCoverage < 0.003)) return []
    const instanceMask = componentMask(mask, component)
    const analysis = inferSinglePetAnalysis(image, instanceMask)
    if (analysis === undefined) return []
    if (index > 0 && relativeArea < 0.35 && analysis.confidence < 0.6) return []
    return [{ analysis, instanceMask, component, sourceArea, relativeArea }]
  })
  if (retained.length === 0) return undefined
  const instances = retained.map((entry, index): PetInstanceAnalysis => {
    const instanceId = `pet-${String(index + 1).padStart(2, '0')}`
    const analysis = prefixedPetAnalysis(entry.analysis, instanceId)
    return {
      ...analysis,
      instanceId,
      instanceMask: entry.instanceMask,
      bounds: {
        x: entry.component.bounds.left,
        y: entry.component.bounds.top,
        width: entry.component.bounds.width,
        height: entry.component.bounds.height,
      },
      sourceArea: entry.sourceArea,
      relativeArea: entry.relativeArea,
    }
  })
  const totalArea = instances.reduce((sum, instance) => sum + instance.sourceArea, 0)
  const confidence = totalArea === 0
    ? 0
    : instances.reduce((sum, instance) => sum + instance.confidence * instance.sourceArea, 0) / totalArea
  return {
    instances,
    subjectMask: combinedMask(instances.map((instance) => instance.instanceMask)),
    suggestedCrop: combinedCrop(image, instances.flatMap((instance) => [
      instance.suggestedCrop,
      instance.bounds,
    ])),
    confidence,
  }
}

export function inferPetAnalysis(image: PixelImage, mask: BinaryMask): PetAnalysisResult | undefined {
  validate(image, mask)
  return inferSinglePetAnalysis(image, principalComponentMask(mask))
}
