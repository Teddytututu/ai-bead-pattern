function validateImage(image, label) {
  if (image === null || typeof image !== 'object'
    || Number.isInteger(image.width) === false || Number.isInteger(image.height) === false
    || image.width <= 0 || image.height <= 0
    || image.data instanceof Uint8ClampedArray === false
    || image.data.length !== image.width * image.height * 4) {
    throw new RangeError(`${label} must contain valid RGBA pixels`)
  }
}

function validateMask(mask, label) {
  if (mask === undefined) return
  if (mask === null || typeof mask !== 'object'
    || Number.isInteger(mask.width) === false || Number.isInteger(mask.height) === false
    || mask.width <= 0 || mask.height <= 0
    || (mask.values instanceof Float32Array === false && Array.isArray(mask.values) === false)
    || mask.values.length !== mask.width * mask.height) {
    throw new RangeError(`${label} must contain aligned mask values`)
  }
}

const HEAD_LANDMARK_KINDS = new Set([
  'eye',
  'ear',
  'nose',
  'mouth',
  'face-contour',
])

const HEAD_STRUCTURAL_ROLES = new Set([
  'eye-center',
  'ear-tip',
  'ear-root',
  'nose-tip',
  'mouth-corner',
  'upper-jaw',
  'lower-jaw',
])

const LANDMARK_OBSERVATION_STATES = new Set(['observed', 'inferred', 'missing'])

function confidence(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || Number.isFinite(value) === false || value < 0 || value > 1) {
    throw new RangeError(`${label} must stay within 0..1`)
  }
  return value
}

function validateLandmarks(landmarks, image, label) {
  if (landmarks === undefined) return
  if (Array.isArray(landmarks) === false) {
    throw new TypeError(`${label} must be an array`)
  }
  for (const [index, landmark] of landmarks.entries()) {
    if (landmark === null || typeof landmark !== 'object' || Array.isArray(landmark)) {
      throw new TypeError(`${label} landmark ${index} must be an object`)
    }
    if (typeof landmark.kind !== 'string' || landmark.kind.length === 0) {
      throw new TypeError(`${label} landmark ${index} kind must be a non-empty string`)
    }
    if (typeof landmark.x !== 'number' || Number.isFinite(landmark.x) === false
      || typeof landmark.y !== 'number' || Number.isFinite(landmark.y) === false
      || landmark.x < 0 || landmark.x >= image.width
      || landmark.y < 0 || landmark.y >= image.height) {
      throw new RangeError(`${label} landmark ${index} coordinates must lie inside the image`)
    }
    confidence(landmark.confidence, `${label} landmark confidence ${index}`)
    if (landmark.observationState !== undefined
      && LANDMARK_OBSERVATION_STATES.has(landmark.observationState) === false) {
      throw new RangeError(`${label} landmark ${index} observation state is unsupported`)
    }
  }
}

function normalizedCrop(crop, image) {
  if (crop === undefined) return undefined
  if (crop === null || typeof crop !== 'object' || Array.isArray(crop)
    || typeof crop.x !== 'number' || Number.isFinite(crop.x) === false
    || typeof crop.y !== 'number' || Number.isFinite(crop.y) === false
    || typeof crop.width !== 'number' || Number.isFinite(crop.width) === false
    || typeof crop.height !== 'number' || Number.isFinite(crop.height) === false
    || crop.width <= 0 || crop.height <= 0) {
    throw new RangeError('OpenCLIP reference crop must contain finite positive dimensions')
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

function croppedImage(image, crop) {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4)
  for (let y = 0; y < crop.height; y += 1) for (let x = 0; x < crop.width; x += 1) {
    const sourceOffset = ((crop.y + y) * image.width + crop.x + x) * 4
    const targetOffset = (y * crop.width + x) * 4
    data[targetOffset] = image.data[sourceOffset]
    data[targetOffset + 1] = image.data[sourceOffset + 1]
    data[targetOffset + 2] = image.data[sourceOffset + 2]
    data[targetOffset + 3] = image.data[sourceOffset + 3]
  }
  return { width: crop.width, height: crop.height, data }
}

function croppedMask(mask, image, crop) {
  if (mask === undefined) return undefined
  const values = new Float32Array(crop.width * crop.height)
  for (let y = 0; y < crop.height; y += 1) for (let x = 0; x < crop.width; x += 1) {
    values[y * crop.width + x] = maskCoverage(mask, image, crop.x + x, crop.y + y)
  }
  return { width: crop.width, height: crop.height, values }
}

function croppedLandmarks(landmarks, crop) {
  if (landmarks === undefined) return undefined
  return landmarks
    .filter((landmark) => landmark.x >= crop.x && landmark.y >= crop.y
      && landmark.x < crop.x + crop.width && landmark.y < crop.y + crop.height)
    .map((landmark) => ({
      ...landmark,
      x: landmark.x - crop.x,
      y: landmark.y - crop.y,
    }))
}

function cropReferenceInput(input) {
  const crop = normalizedCrop(input.referenceCrop, input.referenceImage)
  if (crop === undefined) return input
  return {
    ...input,
    referenceImage: croppedImage(input.referenceImage, crop),
    referenceSubjectMask: croppedMask(input.referenceSubjectMask, input.referenceImage, crop),
    referenceFaceMask: croppedMask(input.referenceFaceMask, input.referenceImage, crop),
    referenceHeadLandmarks: croppedLandmarks(input.referenceHeadLandmarks, crop),
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function maskBounds(mask, threshold = 0.2) {
  let minimumX = mask.width
  let minimumY = mask.height
  let maximumX = -1
  let maximumY = -1
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
    const value = mask.values[y * mask.width + x]
    if (Number.isFinite(value) === false || value < threshold) continue
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x)
    maximumY = Math.max(maximumY, y)
  }
  if (maximumX < minimumX || maximumY < minimumY) return undefined
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  }
}

function canonicalImageFrame(image) {
  const longest = Math.max(image.width, image.height)
  const width = image.width / longest
  const height = image.height / longest
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

function canonicalMaskBounds(mask, image) {
  const bounds = maskBounds(mask)
  if (bounds === undefined) return undefined
  const imageFrame = canonicalImageFrame(image)
  return {
    x: imageFrame.x + bounds.x / mask.width * imageFrame.width,
    y: imageFrame.y + bounds.y / mask.height * imageFrame.height,
    width: bounds.width / mask.width * imageFrame.width,
    height: bounds.height / mask.height * imageFrame.height,
  }
}

function landmarkObservationState(landmark) {
  if (landmark.observationState !== undefined) return landmark.observationState
  return landmark.confidence < 0.2 ? 'missing' : 'observed'
}

function headLandmark(landmark) {
  return HEAD_LANDMARK_KINDS.has(landmark.kind)
    || HEAD_STRUCTURAL_ROLES.has(landmark.structuralRole)
}

function landmarkReliability(landmark) {
  const state = landmarkObservationState(landmark)
  if (state === 'missing') return 0
  return state === 'inferred' ? landmark.confidence * 0.65 : landmark.confidence
}

function canonicalHeadBounds(landmarks, image) {
  if (landmarks === undefined) return undefined
  const used = landmarks.filter((landmark) => headLandmark(landmark)
    && landmarkObservationState(landmark) !== 'missing'
    && landmarkReliability(landmark) > 0)
  if (used.length < 2) return undefined
  const imageFrame = canonicalImageFrame(image)
  const points = used.map((landmark) => ({
    x: imageFrame.x + landmark.x / image.width * imageFrame.width,
    y: imageFrame.y + landmark.y / image.height * imageFrame.height,
  }))
  const minimumX = Math.min(...points.map((point) => point.x))
  const maximumX = Math.max(...points.map((point) => point.x))
  const minimumY = Math.min(...points.map((point) => point.y))
  const maximumY = Math.max(...points.map((point) => point.y))
  if (maximumX - minimumX <= 1e-6 && maximumY - minimumY <= 1e-6) return undefined
  const width = Math.max(0.02, maximumX - minimumX)
  const height = Math.max(0.02, maximumY - minimumY)
  return {
    bounds: {
      x: (minimumX + maximumX) / 2 - width / 2,
      y: (minimumY + maximumY) / 2 - height / 2,
      width,
      height,
    },
    confidence: used.reduce((sum, landmark) => sum + landmarkReliability(landmark), 0) / used.length,
  }
}

function sharedSquareFrame(referenceBounds, candidateBounds) {
  const left = Math.min(referenceBounds.x, candidateBounds.x)
  const top = Math.min(referenceBounds.y, candidateBounds.y)
  const right = Math.max(
    referenceBounds.x + referenceBounds.width,
    candidateBounds.x + candidateBounds.width,
  )
  const bottom = Math.max(
    referenceBounds.y + referenceBounds.height,
    candidateBounds.y + candidateBounds.height,
  )
  const contentSize = Math.max(right - left, bottom - top)
  const size = Math.max(1e-6, contentSize * 1.16)
  return {
    x: (left + right) / 2 - size / 2,
    y: (top + bottom) / 2 - size / 2,
    size,
  }
}

function maskCoverage(mask, image, x, y) {
  const maskX = clamp(Math.floor((x + 0.5) / image.width * mask.width), 0, mask.width - 1)
  const maskY = clamp(Math.floor((y + 0.5) / image.height * mask.height), 0, mask.height - 1)
  const value = mask.values[maskY * mask.width + maskX]
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0
}

function maskedSharedFrame(image, mask, frame, size = 224) {
  const imageFrame = canonicalImageFrame(image)
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const targetOffset = (y * size + x) * 4
    data[targetOffset] = 255
    data[targetOffset + 1] = 255
    data[targetOffset + 2] = 255
    data[targetOffset + 3] = 255
    const canonicalX = frame.x + (x + 0.5) / size * frame.size
    const canonicalY = frame.y + (y + 0.5) / size * frame.size
    const normalizedX = (canonicalX - imageFrame.x) / imageFrame.width
    const normalizedY = (canonicalY - imageFrame.y) / imageFrame.height
    if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) continue
    const sourceX = clamp(Math.floor(normalizedX * image.width), 0, image.width - 1)
    const sourceY = clamp(Math.floor(normalizedY * image.height), 0, image.height - 1)
    const sourceOffset = (sourceY * image.width + sourceX) * 4
    const coverage = maskCoverage(mask, image, sourceX, sourceY) * image.data[sourceOffset + 3] / 255
    data[targetOffset] = Math.round(image.data[sourceOffset] * coverage + 255 * (1 - coverage))
    data[targetOffset + 1] = Math.round(image.data[sourceOffset + 1] * coverage + 255 * (1 - coverage))
    data[targetOffset + 2] = Math.round(image.data[sourceOffset + 2] * coverage + 255 * (1 - coverage))
  }
  return { width: size, height: size, data }
}

function imageSharedFrame(image, frame, size = 224) {
  const imageFrame = canonicalImageFrame(image)
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const targetOffset = (y * size + x) * 4
    data[targetOffset] = 255
    data[targetOffset + 1] = 255
    data[targetOffset + 2] = 255
    data[targetOffset + 3] = 255
    const canonicalX = frame.x + (x + 0.5) / size * frame.size
    const canonicalY = frame.y + (y + 0.5) / size * frame.size
    const normalizedX = (canonicalX - imageFrame.x) / imageFrame.width
    const normalizedY = (canonicalY - imageFrame.y) / imageFrame.height
    if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) continue
    const sourceX = clamp(Math.floor(normalizedX * image.width), 0, image.width - 1)
    const sourceY = clamp(Math.floor(normalizedY * image.height), 0, image.height - 1)
    const sourceOffset = (sourceY * image.width + sourceX) * 4
    const coverage = image.data[sourceOffset + 3] / 255
    data[targetOffset] = Math.round(image.data[sourceOffset] * coverage + 255 * (1 - coverage))
    data[targetOffset + 1] = Math.round(image.data[sourceOffset + 1] * coverage + 255 * (1 - coverage))
    data[targetOffset + 2] = Math.round(image.data[sourceOffset + 2] * coverage + 255 * (1 - coverage))
  }
  return { width: size, height: size, data }
}

function viewGeometry(referenceBounds, candidateBounds, frame) {
  const referenceArea = Math.max(1e-8, referenceBounds.width * referenceBounds.height)
  const candidateArea = Math.max(1e-8, candidateBounds.width * candidateBounds.height)
  const areaScaleRatio = candidateArea / referenceArea
  const referenceCenter = {
    x: referenceBounds.x + referenceBounds.width / 2,
    y: referenceBounds.y + referenceBounds.height / 2,
  }
  const candidateCenter = {
    x: candidateBounds.x + candidateBounds.width / 2,
    y: candidateBounds.y + candidateBounds.height / 2,
  }
  const centerOffset = Math.hypot(
    candidateCenter.x - referenceCenter.x,
    candidateCenter.y - referenceCenter.y,
  ) / frame.size
  const referenceAspect = referenceBounds.width / Math.max(1e-8, referenceBounds.height)
  const candidateAspect = candidateBounds.width / Math.max(1e-8, candidateBounds.height)
  const aspectRatioError = Math.abs(Math.log(candidateAspect / referenceAspect))
  const retention = clamp(Math.exp(
    -Math.abs(Math.log(areaScaleRatio)) * 0.55
      - centerOffset * 1.5
      - aspectRatioError * 0.35,
  ), 0, 1)
  return { areaScaleRatio, centerOffset, aspectRatioError, retention }
}

function pairedConfidence(...values) {
  const available = values.filter((value) => value !== undefined)
  return available.length === 0 ? 1 : Math.min(...available)
}

function cropView(
  id,
  referenceImage,
  candidateImage,
  referenceMask,
  candidateMask,
  evidenceConfidence,
) {
  if (referenceMask === undefined || candidateMask === undefined) return undefined
  const referenceBounds = canonicalMaskBounds(referenceMask, referenceImage)
  const candidateBounds = canonicalMaskBounds(candidateMask, candidateImage)
  if (referenceBounds === undefined || candidateBounds === undefined) return undefined
  const frame = sharedSquareFrame(referenceBounds, candidateBounds)
  return {
    id,
    referenceImage: maskedSharedFrame(referenceImage, referenceMask, frame),
    candidateImage: maskedSharedFrame(candidateImage, candidateMask, frame),
    evidenceConfidence,
    geometry: viewGeometry(referenceBounds, candidateBounds, frame),
  }
}

function scopedViewId(prefix, kind) {
  if (prefix === undefined) return kind
  if (typeof prefix !== 'string' || /^[A-Za-z0-9._-]+$/.test(prefix) === false) {
    throw new RangeError('OpenCLIP view id prefix must use letters, numbers, dot, underscore, or dash')
  }
  return `${prefix}:${kind}`
}

function headLandmarksView(input, id) {
  const reference = canonicalHeadBounds(input.referenceHeadLandmarks, input.referenceImage)
  const candidate = canonicalHeadBounds(input.candidateHeadLandmarks, input.candidateImage)
  if (reference === undefined || candidate === undefined) return undefined
  const frame = sharedSquareFrame(reference.bounds, candidate.bounds)
  return {
    id,
    referenceImage: imageSharedFrame(input.referenceImage, frame),
    candidateImage: imageSharedFrame(input.candidateImage, frame),
    evidenceConfidence: pairedConfidence(
      reference.confidence,
      candidate.confidence,
      input.referenceSubjectConfidence,
      input.candidateSubjectConfidence,
      input.referenceFaceConfidence,
      input.candidateFaceConfidence,
    ),
    geometry: viewGeometry(reference.bounds, candidate.bounds, frame),
  }
}

export function createOpenClipScoringViews(input) {
  validateImage(input.referenceImage, 'OpenCLIP reference image')
  validateImage(input.candidateImage, 'OpenCLIP candidate image')
  validateMask(input.referenceSubjectMask, 'OpenCLIP reference subject mask')
  validateMask(input.candidateSubjectMask, 'OpenCLIP candidate subject mask')
  validateMask(input.referenceFaceMask, 'OpenCLIP reference face mask')
  validateMask(input.candidateFaceMask, 'OpenCLIP candidate face mask')
  validateLandmarks(
    input.referenceHeadLandmarks,
    input.referenceImage,
    'OpenCLIP reference head',
  )
  validateLandmarks(
    input.candidateHeadLandmarks,
    input.candidateImage,
    'OpenCLIP candidate head',
  )
  confidence(input.referenceSubjectConfidence, 'OpenCLIP reference subject confidence')
  confidence(input.candidateSubjectConfidence, 'OpenCLIP candidate subject confidence')
  confidence(input.referenceFaceConfidence, 'OpenCLIP reference face confidence')
  confidence(input.candidateFaceConfidence, 'OpenCLIP candidate face confidence')
  if (input.includeGlobal !== undefined && typeof input.includeGlobal !== 'boolean') {
    throw new TypeError('OpenCLIP includeGlobal must be boolean')
  }
  const globalId = scopedViewId(input.viewIdPrefix, 'global')
  const subjectId = scopedViewId(input.viewIdPrefix, 'subject-mask')
  const faceId = scopedViewId(input.viewIdPrefix, 'face-mask')
  const headId = scopedViewId(input.viewIdPrefix, 'head-landmarks')
  const prepared = cropReferenceInput(input)
  const views = input.includeGlobal === false ? [] : [{
    id: globalId,
    referenceImage: prepared.referenceImage,
    candidateImage: prepared.candidateImage,
    evidenceConfidence: 1,
  }]
  const subject = cropView(
    subjectId,
    prepared.referenceImage,
    prepared.candidateImage,
    prepared.referenceSubjectMask,
    prepared.candidateSubjectMask,
    pairedConfidence(prepared.referenceSubjectConfidence, prepared.candidateSubjectConfidence),
  )
  if (subject !== undefined) views.push(subject)
  const face = cropView(
    faceId,
    prepared.referenceImage,
    prepared.candidateImage,
    prepared.referenceFaceMask,
    prepared.candidateFaceMask,
    pairedConfidence(prepared.referenceFaceConfidence, prepared.candidateFaceConfidence),
  )
  if (face !== undefined) views.push(face)
  const head = headLandmarksView(prepared, headId)
  if (head !== undefined) views.push(head)
  return views
}
