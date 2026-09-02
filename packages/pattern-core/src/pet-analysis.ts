import type {
  BinaryMask,
  CropRect,
  ImageLandmark,
  PixelImage,
} from './types.js'

export interface PetAnalysisResult {
  imageType: 'pet'
  headPose: 'frontal' | 'profile-left' | 'profile-right'
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

interface ProfileAnalysis {
  pose: 'profile-left' | 'profile-right'
  direction: -1 | 1
  ear: PointScore
  eye: PointScore
  nose: PointScore
  mouth: PointScore
  upperJaw: PointScore
  lowerJaw: PointScore
  headWidth: number
  headHeight: number
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

function principalComponentMask(mask: BinaryMask): BinaryMask {
  const visited = new Uint8Array(mask.values.length)
  let selected: number[] = []
  for (let start = 0; start < mask.values.length; start += 1) {
    if (visited[start] !== 0 || (mask.values[start] ?? 0) < 0.5) continue
    const component: number[] = []
    const queue = [start]
    visited[start] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!
      component.push(current)
      const x = current % mask.width
      const y = Math.floor(current / mask.width)
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
    if (component.length > selected.length) selected = component
  }
  if (selected.length === 0 || selected.length === mask.values.length) return mask
  const values = new Float32Array(mask.values.length)
  for (const index of selected) values[index] = mask.values[index] ?? 0
  return { width: mask.width, height: mask.height, values }
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
    return forward * 0.25
      + (1 - luminance(image, x, y)) * 0.32
      + localContrast(image, x, y, Math.max(1, Math.round(headWidth * 0.025))) * 0.28
      + redExcess(image, x, y) * 0.08
      + vertical * 0.07
  })
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
  if (elongatedProfile === false && profileEvidence < 0.78) return undefined

  const eyeExpectedX = nose.x - direction * headWidth * 0.3
  const eyeExpectedY = bounds.top + headHeight * 0.28
  const eye = refineEyeCenter(
    image,
    mask,
    profileFeature(image, mask, eyeExpectedX, eyeExpectedY, headWidth * 0.2, headHeight * 0.28),
    headWidth * 0.06,
  )
  const ear = strongestPoint(image, mask, {
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
  const mouthExpectedX = eye.x + (nose.x - eye.x) * 0.58
  const mouthExpectedY = nose.y + headHeight * 0.08
  const mouth = profileFeature(
    image, mask, mouthExpectedX, mouthExpectedY, headWidth * 0.18, headHeight * 0.15,
  )
  const upperJaw = profileBoundaryPoint(
    mask, bounds, direction, nose.y - headHeight * 0.06, headHeight * 0.08, headWidth * 0.05,
  )
  const lowerJaw = profileBoundaryPoint(
    mask, bounds, direction, nose.y + headHeight * 0.09, headHeight * 0.08, headWidth * 0.1,
  )
  const confidence = Math.max(0.5, clamp(
    profileEvidence * 0.38 + nose.score * 0.2 + eye.score * 0.22 + mouth.score * 0.12 + ear.score * 0.08,
    0,
    1,
  ))
  return {
    pose: direction === 1 ? 'profile-right' : 'profile-left',
    direction,
    ear,
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
  let best: PointScore = {
    x: clamp(Math.round(expectedX), 0, image.width - 1),
    y: clamp(Math.round(expectedY), 0, image.height - 1),
    score: 0,
  }
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

function cropAroundBounds(image: PixelImage, bounds: Bounds, marginRatio: number): CropRect {
  const margin = Math.max(2, Math.round(Math.max(bounds.width, bounds.height) * marginRatio))
  const left = clamp(bounds.left - margin, 0, image.width - 1)
  const top = clamp(bounds.top - margin, 0, image.height - 1)
  const right = clamp(bounds.right + margin + 1, left + 1, image.width)
  const bottom = clamp(bounds.bottom + margin + 1, top + 1, image.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function profileBodyEndpoints(
  image: PixelImage,
  mask: BinaryMask,
  bounds: Bounds,
  direction: -1 | 1,
): { tail: PointScore, frontPaw: PointScore, rearPaw: PointScore } {
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
  return { tail, frontPaw, rearPaw }
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
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v2' }],
    ...options,
  }
}

export function inferPetAnalysis(image: PixelImage, mask: BinaryMask): PetAnalysisResult | undefined {
  validate(image, mask)
  const analysisMask = principalComponentMask(mask)
  const bounds = maskBounds(analysisMask)
  if (bounds === undefined || bounds.width < 6 || bounds.height < 6) return undefined
  const profile = inferProfileAnalysis(image, analysisMask, bounds)
  if (profile !== undefined) {
    const crop = cropAroundBounds(image, bounds, 0.08)
    const body = profileBodyEndpoints(image, analysisMask, bounds, profile.direction)
    const bodyLandmarkOptions: Partial<ImageLandmark> = {
      priority: 'soft',
      sourceRadiusPx: 2,
      gridRadiusCells: 0.5,
      carrierRegionId: 'subject',
      affectsOccupancy: true,
    }
    const landmarks = [
      landmark('visible-ear-tip', 'ear', profile.ear, profile.confidence, { affectsOccupancy: true }),
      landmark('visible-eye-center', 'eye', profile.eye, profile.eye.score, { gridRadiusCells: 0 }),
      landmark('nose-tip', 'nose', profile.nose, profile.nose.score),
      landmark('mouth-corner', 'mouth', profile.mouth, profile.mouth.score),
      landmark('upper-jaw-end', 'face-contour', profile.upperJaw, profile.confidence, { affectsOccupancy: true }),
      landmark('lower-jaw-end', 'face-contour', profile.lowerJaw, profile.confidence, { affectsOccupancy: true }),
      landmark('tail-tip', 'body', body.tail, profile.confidence * 0.8, bodyLandmarkOptions),
      landmark('front-paw', 'body', body.frontPaw, profile.confidence * 0.8, bodyLandmarkOptions),
      landmark('rear-paw', 'body', body.rearPaw, profile.confidence * 0.8, bodyLandmarkOptions),
    ]
    return {
      imageType: 'pet',
      headPose: profile.pose,
      landmarks,
      faceMask: profileFaceMask(analysisMask, profile),
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
  const noseSeed = noseFeature(
    image,
    analysisMask,
    centerX,
    Math.min(bounds.bottom, earTop + faceWidth * 0.8),
    faceWidth * 0.18,
  )
  const faceAxisX = noseSeed.score >= 0.28
    ? centerX * 0.2 + noseSeed.x * 0.8
    : centerX
  const [rawLeftEye, rawRightEye] = eyePair(
    image,
    analysisMask,
    faceAxisX,
    faceWidth,
    earTop,
  )
  const leftEye = refineEyeCenter(image, analysisMask, rawLeftEye, faceWidth * 0.07)
  const rightEye = refineEyeCenter(image, analysisMask, rawRightEye, faceWidth * 0.07)
  const eyeY = (leftEye.y + rightEye.y) / 2
  const eyeMidpointX = (leftEye.x + rightEye.x) / 2
  const nose = noseFeature(image, analysisMask, eyeMidpointX, eyeY + faceWidth * 0.21, faceWidth * 0.13)
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
    headPose: 'frontal',
    landmarks,
    faceMask: petFaceMask(
      analysisMask,
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
