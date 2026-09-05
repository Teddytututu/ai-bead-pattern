import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assessPetInstanceIntegrity,
  evaluatePetPoseStructure,
  petPoseSchema,
  type ImageAnalysis,
  type ImageLandmark,
  type SemanticRegion,
} from '../src/index.js'

const width = 20
const height = 20

function bodyLandmark(
  id: string,
  structuralRole: NonNullable<ImageLandmark['structuralRole']>,
  x: number,
  y: number,
): ImageLandmark {
  return {
    id,
    kind: 'body',
    structuralRole,
    x,
    y,
    confidence: 0.9,
    priority: 'hard',
    affectsOccupancy: true,
  }
}

function analysis(): ImageAnalysis {
  return {
    imageType: 'pet',
    landmarks: [
      bodyLandmark('visible-ear-tip', 'ear-tip' as NonNullable<ImageLandmark['structuralRole']>, 14, 2),
      bodyLandmark('visible-ear-root', 'ear-root' as NonNullable<ImageLandmark['structuralRole']>, 13, 4),
      bodyLandmark('nose-tip', 'nose-tip' as NonNullable<ImageLandmark['structuralRole']>, 17, 5),
      bodyLandmark('upper-jaw-end', 'upper-jaw' as NonNullable<ImageLandmark['structuralRole']>, 16, 6),
      bodyLandmark('lower-jaw-end', 'lower-jaw' as NonNullable<ImageLandmark['structuralRole']>, 16, 8),
      bodyLandmark('neck-base', 'neck-base', 13, 4),
      bodyLandmark('visible-shoulder', 'shoulder', 12, 6),
      bodyLandmark('back-middle', 'back-middle', 8, 6),
      bodyLandmark('tail-root', 'tail-root', 5, 8),
      bodyLandmark('visible-hip', 'hip', 6, 10),
      bodyLandmark('front-knee', 'front-knee', 13, 12),
      bodyLandmark('front-paw', 'front-paw', 13, 17),
      bodyLandmark('rear-knee', 'rear-knee', 8, 13),
      bodyLandmark('rear-paw', 'rear-paw', 7, 17),
      bodyLandmark('tail-tip', 'tail-tip', 2, 10),
    ],
  }
}

function frontalAnalysis(): ImageAnalysis {
  return {
    imageType: 'pet',
    landmarks: [
      bodyLandmark('left-ear-tip', 'ear-tip', 6, 2),
      bodyLandmark('right-ear-tip', 'ear-tip', 13, 2),
      bodyLandmark('left-ear-root', 'ear-root', 7, 6),
      bodyLandmark('right-ear-root', 'ear-root', 12, 6),
      bodyLandmark('left-eye-center', 'eye-center', 8, 8),
      bodyLandmark('right-eye-center', 'eye-center', 11, 8),
      bodyLandmark('nose-tip', 'nose-tip', 10, 10),
      bodyLandmark('left-mouth-corner', 'mouth-corner', 8, 12),
      bodyLandmark('right-mouth-corner', 'mouth-corner', 11, 12),
    ],
  }
}

function mask(paint: (values: Uint8Array) => void): Uint8Array {
  const values = new Uint8Array(width * height)
  paint(values)
  return values
}

function set(values: Uint8Array, x: number, y: number): void {
  if (x >= 0 && y >= 0 && x < width && y < height) values[y * width + x] = 1
}

function line(values: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let step = 0; step <= steps; step += 1) {
    set(values, Math.round(x0 + (x1 - x0) * step / steps), Math.round(y0 + (y1 - y0) * step / steps))
  }
}

const faceGridSize = 64

function setFaceCell(values: Uint8Array, x: number, y: number): void {
  if (x >= 0 && y >= 0 && x < faceGridSize && y < faceGridSize) {
    values[y * faceGridSize + x] = 1
  }
}

function faceLine(values: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let step = 0; step <= steps; step += 1) {
    setFaceCell(
      values,
      Math.round(x0 + (x1 - x0) * step / steps),
      Math.round(y0 + (y1 - y0) * step / steps),
    )
  }
}

function faceMask(): Uint8Array {
  const values = new Uint8Array(faceGridSize * faceGridSize)
  for (let y = 20; y <= 52; y += 1) {
    for (let x = 14; x <= 50; x += 1) {
      const dx = (x - 32) / 17
      const dy = (y - 36) / 16
      if (dx * dx + dy * dy <= 1) setFaceCell(values, x, y)
    }
  }
  faceLine(values, 22, 15, 27, 25)
  faceLine(values, 42, 15, 37, 25)
  return values
}

function largeFrontalAnalysis(): ImageAnalysis {
  return {
    imageType: 'pet',
    landmarks: [
      bodyLandmark('left-ear-tip', 'ear-tip', 22, 15),
      bodyLandmark('right-ear-tip', 'ear-tip', 42, 15),
      bodyLandmark('left-ear-root', 'ear-root', 27, 25),
      bodyLandmark('right-ear-root', 'ear-root', 37, 25),
      bodyLandmark('left-eye-center', 'eye-center', 27, 31),
      bodyLandmark('right-eye-center', 'eye-center', 37, 31),
      bodyLandmark('nose-tip', 'nose-tip', 32, 35),
      bodyLandmark('left-mouth-corner', 'mouth-corner', 29, 39),
      bodyLandmark('right-mouth-corner', 'mouth-corner', 35, 39),
    ],
  }
}

function rotatePoint(
  x: number,
  y: number,
  angleDegrees: number,
): readonly [number, number] {
  const radians = angleDegrees * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const dx = x - 32
  const dy = y - 32
  return [
    Math.round(32 + dx * cosine - dy * sine),
    Math.round(32 + dx * sine + dy * cosine),
  ]
}

function rotateFaceAnalysis(input: ImageAnalysis, angleDegrees: number): ImageAnalysis {
  return {
    ...input,
    landmarks: (input.landmarks ?? []).map((landmark) => {
      const [x, y] = rotatePoint(landmark.x, landmark.y, angleDegrees)
      return { ...landmark, x, y }
    }),
  }
}

function rotateFaceMask(input: Uint8Array, angleDegrees: number): Uint8Array {
  const result = new Uint8Array(input.length)
  for (let sourceY = 0; sourceY < faceGridSize; sourceY += 1) {
    for (let sourceX = 0; sourceX < faceGridSize; sourceX += 1) {
      if (input[sourceY * faceGridSize + sourceX] !== 1) continue
      const [x, y] = rotatePoint(sourceX, sourceY, angleDegrees)
      setFaceCell(result, x, y)
    }
  }
  for (let y = 0; y < faceGridSize; y += 1) {
    for (let x = 0; x < faceGridSize; x += 1) {
      const [sourceX, sourceY] = rotatePoint(x, y, -angleDegrees)
      if (sourceX >= 0 && sourceY >= 0 && sourceX < faceGridSize && sourceY < faceGridSize) {
        result[y * faceGridSize + x] = Math.max(
          result[y * faceGridSize + x]!,
          input[sourceY * faceGridSize + sourceX]!,
        )
      }
    }
  }
  const [leftTipX, leftTipY] = rotatePoint(22, 15, angleDegrees)
  const [leftRootX, leftRootY] = rotatePoint(27, 25, angleDegrees)
  const [rightTipX, rightTipY] = rotatePoint(42, 15, angleDegrees)
  const [rightRootX, rightRootY] = rotatePoint(37, 25, angleDegrees)
  faceLine(result, leftTipX, leftTipY, leftRootX, leftRootY)
  faceLine(result, rightTipX, rightTipY, rightRootX, rightRootY)
  return result
}

function mirrorFaceAnalysis(input: ImageAnalysis): ImageAnalysis {
  return {
    ...input,
    landmarks: (input.landmarks ?? []).map((landmark) => ({
      ...landmark,
      x: faceGridSize - 1 - landmark.x,
    })),
  }
}

function mirrorFaceMask(input: Uint8Array): Uint8Array {
  const result = new Uint8Array(input.length)
  for (let y = 0; y < faceGridSize; y += 1) {
    for (let x = 0; x < faceGridSize; x += 1) {
      result[y * faceGridSize + x] = input[y * faceGridSize + faceGridSize - 1 - x]!
    }
  }
  return result
}

function evaluateLargeFace(analysis: ImageAnalysis, activeMask: Uint8Array) {
  return evaluatePetPoseStructure({
    analysis,
    crop: { x: 0, y: 0, width: faceGridSize, height: faceGridSize },
    fit: { x: 0, y: 0, width: faceGridSize, height: faceGridSize },
    activeMask,
    width: faceGridSize,
    height: faceGridSize,
  })
}

function subjectRegion(
  instanceId: string,
  regionWidth: number,
  regionHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): SemanticRegion {
  const values = new Float32Array(regionWidth * regionHeight)
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) values[y * regionWidth + x] = 1
  }
  return {
    id: `${instanceId}:subject`,
    label: 'pet instance',
    confidence: 0.9,
    mask: { width: regionWidth, height: regionHeight, values },
  }
}

function frontalInstance(instanceId: string, centerX: number): readonly ImageLandmark[] {
  return [
    bodyLandmark(`${instanceId}:left-ear-tip`, 'ear-tip', centerX - 4, 2),
    bodyLandmark(`${instanceId}:right-ear-tip`, 'ear-tip', centerX + 4, 2),
    bodyLandmark(`${instanceId}:left-ear-root`, 'ear-root', centerX - 3, 6),
    bodyLandmark(`${instanceId}:right-ear-root`, 'ear-root', centerX + 3, 6),
    bodyLandmark(`${instanceId}:left-eye`, 'eye-center', centerX - 2, 8),
    bodyLandmark(`${instanceId}:right-eye`, 'eye-center', centerX + 2, 8),
    bodyLandmark(`${instanceId}:nose`, 'nose-tip', centerX, 10),
    bodyLandmark(`${instanceId}:left-mouth`, 'mouth-corner', centerX - 2, 12),
    bodyLandmark(`${instanceId}:right-mouth`, 'mouth-corner', centerX + 2, 12),
  ]
}

describe('quadruped pose structure evaluation', () => {
  it('pins the upstream instance and animal-keypoint contracts behind multi-pet scoring', () => {
    assert.deepEqual(petPoseSchema.upstreamContracts, [
      'facebookresearch/detectron2@a2f4a8771ab77e8411c26b27f24f9489a28a2453',
      'open-mmlab/mmpose@v1.3.2#5408bc76f5b848cf925a0d1857899011d8c5b497',
      'AlexTheBad/AP-10K@181b1a04755e4dc6fe5616ef7a88496f47bfe228',
    ])
    assert.ok(petPoseSchema.projectHeuristics.includes('mean-source-retention-times-grid-occupancy'))
    assert.ok(petPoseSchema.projectHeuristics.includes('weakest-instance-landmark-coverage'))
    assert.ok(petPoseSchema.projectHeuristics.includes('shared-grid-cell-owner-rate'))
    assert.deepEqual(petPoseSchema.licenses, {
      detectron2: 'Apache-2.0',
      mmpose: 'Apache-2.0',
      ap10k: 'CC-BY-4.0',
    })
  })

  it('keeps every single-pet metric identical when landmark ids gain an instance prefix', () => {
    const activeMask = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 14, 2, 13, 4)
      line(values, 17, 5, 16, 6)
      line(values, 17, 5, 16, 8)
      line(values, 13, 4, 12, 6)
      line(values, 12, 6, 10, 10)
      line(values, 10, 10, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const baseAnalysis = analysis()
    const prefixedAnalysis: ImageAnalysis = {
      ...baseAnalysis,
      landmarks: (baseAnalysis.landmarks ?? []).map((landmark) => ({
        ...landmark,
        id: `pet-01:${landmark.id}`,
      })),
    }
    const common = {
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      activeMask,
      width,
      height,
    }

    assert.deepEqual(
      evaluatePetPoseStructure({ ...common, analysis: prefixedAnalysis }),
      evaluatePetPoseStructure({ ...common, analysis: baseAnalysis }),
    )
  })

  it('keeps partial keypoints from separate pets out of one synthetic frontal face', () => {
    const multiWidth = 40
    const multiHeight = 20
    const multiMask = new Uint8Array(multiWidth * multiHeight)
    for (let y = 5; y <= 15; y += 1) {
      for (const [left, right] of [[2, 13], [25, 36]] as const) {
        for (let x = left; x <= right; x += 1) multiMask[y * multiWidth + x] = 1
      }
    }
    const keyed = (
      instance: string,
      id: string,
      role: NonNullable<ImageLandmark['structuralRole']>,
      x: number,
      y: number,
    ): ImageLandmark => ({
      ...bodyLandmark(`${instance}:${id}`, role, x, y),
      id: `${instance}:${id}`,
    })
    const multiAnalysis: ImageAnalysis = {
      imageType: 'pet',
      landmarks: [
        keyed('pet-01', 'left-ear-tip', 'ear-tip', 4, 2),
        keyed('pet-01', 'left-ear-root', 'ear-root', 5, 6),
        keyed('pet-01', 'left-eye', 'eye-center', 6, 8),
        keyed('pet-01', 'nose', 'nose-tip', 8, 10),
        keyed('pet-02', 'right-ear-tip', 'ear-tip', 34, 2),
        keyed('pet-02', 'right-ear-root', 'ear-root', 33, 6),
        keyed('pet-02', 'right-eye', 'eye-center', 32, 8),
      ],
    }

    const result = evaluatePetPoseStructure({
      analysis: multiAnalysis,
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask: multiMask,
      width: multiWidth,
      height: multiHeight,
    })

    assert.equal(result.available, false)
    assert.equal(result.score, 0)
  })

  it('aggregates complete pet instances toward the weakest structure score', () => {
    const multiWidth = 40
    const multiHeight = 20
    const strongMask = new Uint8Array(multiWidth * multiHeight)
    const weakMask = new Uint8Array(multiWidth * multiHeight)
    const paintLine = (values: Uint8Array, x0: number, y0: number, x1: number, y1: number): void => {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
      for (let step = 0; step <= steps; step += 1) {
        const x = Math.round(x0 + (x1 - x0) * step / steps)
        const y = Math.round(y0 + (y1 - y0) * step / steps)
        values[y * multiWidth + x] = 1
      }
    }
    for (let y = 6; y <= 15; y += 1) {
      for (let x = 3; x <= 13; x += 1) strongMask[y * multiWidth + x] = 1
      for (let x = 25; x <= 35; x += 1) weakMask[y * multiWidth + x] = 1
    }
    paintLine(strongMask, 4, 2, 5, 6)
    paintLine(strongMask, 12, 2, 11, 6)
    for (let y = 2; y <= 15; y += 1) {
      for (let x = 25; x <= 35; x += 1) weakMask[y * multiWidth + x] = 1
    }
    const face = (instance: string, centerX: number): ImageAnalysis => ({
      imageType: 'pet',
      landmarks: [
        bodyLandmark(`${instance}:left-ear-tip`, 'ear-tip', centerX - 4, 2),
        bodyLandmark(`${instance}:right-ear-tip`, 'ear-tip', centerX + 4, 2),
        bodyLandmark(`${instance}:left-ear-root`, 'ear-root', centerX - 3, 6),
        bodyLandmark(`${instance}:right-ear-root`, 'ear-root', centerX + 3, 6),
        bodyLandmark(`${instance}:left-eye`, 'eye-center', centerX - 2, 8),
        bodyLandmark(`${instance}:right-eye`, 'eye-center', centerX + 2, 8),
        bodyLandmark(`${instance}:nose`, 'nose-tip', centerX, 10),
        bodyLandmark(`${instance}:left-mouth`, 'mouth-corner', centerX - 2, 12),
        bodyLandmark(`${instance}:right-mouth`, 'mouth-corner', centerX + 2, 12),
      ],
    })
    const strongAnalysis = face('pet-01', 8)
    const weakAnalysis = face('pet-02', 30)
    const evaluate = (petAnalysis: ImageAnalysis, values: Uint8Array) => evaluatePetPoseStructure({
      analysis: petAnalysis,
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask: values,
      width: multiWidth,
      height: multiHeight,
    })
    const strong = evaluate(strongAnalysis, strongMask)
    const weak = evaluate(weakAnalysis, weakMask)
    const combinedMask = Uint8Array.from(strongMask, (value, index) => Math.max(value, weakMask[index]!))
    const combined = evaluate({
      imageType: 'pet',
      landmarks: [...(strongAnalysis.landmarks ?? []), ...(weakAnalysis.landmarks ?? [])],
    }, combinedMask)
    const arithmeticMean = (strong.score + weak.score) / 2

    assert.ok(strong.score > weak.score + 0.1)
    assert.ok(combined.score < arithmeticMean)
    assert.ok(combined.score <= weak.score + (strong.score - weak.score) * 0.35)
    assert.equal(combined.earConnected, false)
  })

  it('reports continuous subject-component recall when one pet disappears from the grid', () => {
    const multiWidth = 40
    const multiHeight = 20
    const activeMask = new Uint8Array(multiWidth * multiHeight)
    for (let y = 1; y <= 15; y += 1) {
      for (let x = 2; x <= 14; x += 1) activeMask[y * multiWidth + x] = 1
    }
    const result = evaluatePetPoseStructure({
      analysis: {
        imageType: 'pet',
        landmarks: [...frontalInstance('pet-01', 8), ...frontalInstance('pet-02', 31)],
        semanticRegions: [
          subjectRegion('pet-01', multiWidth, multiHeight, 2, 1, 14, 15),
          subjectRegion('pet-02', multiWidth, multiHeight, 25, 1, 37, 15),
        ],
      },
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask,
      width: multiWidth,
      height: multiHeight,
    })

    assert.equal(result.instanceCount, 2)
    assert.ok(Math.abs(result.subjectComponentRecall - 0.5) < 1e-9)
    const integrity = assessPetInstanceIntegrity(result)
    assert.equal(integrity.valid, false)
    assert.ok(integrity.rejectionReasons.includes('pet-instance-recall'))
  })

  it('charges a cropped-out pet to component recall instead of clamping it onto the canvas edge', () => {
    const sourceWidth = 40
    const targetWidth = 20
    const targetHeight = 20
    const activeMask = new Uint8Array(targetWidth * targetHeight).fill(1)
    const result = evaluatePetPoseStructure({
      analysis: {
        imageType: 'pet',
        landmarks: [...frontalInstance('pet-01', 8), ...frontalInstance('pet-02', 31)],
        semanticRegions: [
          subjectRegion('pet-01', sourceWidth, targetHeight, 2, 1, 14, 15),
          subjectRegion('pet-02', sourceWidth, targetHeight, 25, 1, 37, 15),
        ],
      },
      crop: { x: 0, y: 0, width: targetWidth, height: targetHeight },
      fit: { x: 0, y: 0, width: targetWidth, height: targetHeight },
      activeMask,
      width: targetWidth,
      height: targetHeight,
    })

    assert.ok(Math.abs(result.subjectComponentRecall - 0.5) < 1e-9)
  })

  it('reports the weakest identity completeness when a detected pet lacks keypoints', () => {
    const multiWidth = 40
    const multiHeight = 20
    const activeMask = new Uint8Array(multiWidth * multiHeight).fill(1)
    const result = evaluatePetPoseStructure({
      analysis: {
        imageType: 'pet',
        landmarks: frontalInstance('pet-01', 8),
        semanticRegions: [
          subjectRegion('pet-01', multiWidth, multiHeight, 1, 1, 15, 16),
          subjectRegion('pet-02', multiWidth, multiHeight, 24, 1, 38, 16),
        ],
      },
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask,
      width: multiWidth,
      height: multiHeight,
    })

    assert.equal(result.instanceCount, 2)
    assert.equal(result.subjectComponentRecall, 1)
    assert.equal(result.weakestInstanceIdentityCompleteness, 0)
    const integrity = assessPetInstanceIntegrity(result)
    assert.equal(integrity.valid, false)
    assert.ok(integrity.rejectionReasons.includes('pet-instance-identity'))
  })

  it('reports cross-instance collisions when pet keypoints claim the same grid cells', () => {
    const multiWidth = 40
    const multiHeight = 20
    const activeMask = new Uint8Array(multiWidth * multiHeight).fill(1)
    const sharedLandmarks = frontalInstance('pet-01', 20)
    const separated = evaluatePetPoseStructure({
      analysis: {
        imageType: 'pet',
        landmarks: [
          ...frontalInstance('pet-01', 10),
          ...frontalInstance('pet-02', 30),
        ],
      },
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask,
      width: multiWidth,
      height: multiHeight,
    })
    const result = evaluatePetPoseStructure({
      analysis: {
        imageType: 'pet',
        landmarks: [
          ...sharedLandmarks,
          ...sharedLandmarks.map((landmark) => ({
            ...landmark,
            id: landmark.id.replace('pet-01:', 'pet-02:'),
          })),
        ],
      },
      crop: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      fit: { x: 0, y: 0, width: multiWidth, height: multiHeight },
      activeMask,
      width: multiWidth,
      height: multiHeight,
    })

    assert.equal(result.instanceCount, 2)
    assert.equal(separated.crossInstanceCollisionRate, 0)
    assert.equal(result.crossInstanceCollisionRate, 1)
    assert.ok(separated.score > result.score + 0.05)
    const integrity = assessPetInstanceIntegrity(result)
    assert.equal(integrity.valid, false)
    assert.ok(integrity.rejectionReasons.includes('pet-instance-collision'))
  })

  it('scores a frontal face from paired ears, eyes, nose, and mouth without body roles', () => {
    const detailed = mask((values) => {
      for (let y = 6; y <= 15; y += 1) {
        for (let x = 5; x <= 14; x += 1) set(values, x, y)
      }
      line(values, 6, 2, 7, 6)
      line(values, 13, 2, 12, 6)
    })
    const embedded = detailed.slice()
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 5; x <= 14; x += 1) set(embedded, x, y)
    }
    const common = {
      analysis: frontalAnalysis(),
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const clear = evaluatePetPoseStructure({ ...common, activeMask: detailed })
    const collapsed = evaluatePetPoseStructure({ ...common, activeMask: embedded })

    assert.equal(clear.available, true)
    assert.equal((clear as typeof clear & { mode?: string }).mode, 'frontal')
    assert.equal(clear.earConnected, true)
    assert.ok(clear.earStructure > collapsed.earStructure + 0.2)
    assert.ok(clear.muzzleStructure >= 0.55)
    assert.ok(clear.score > collapsed.score + 0.08)
  })

  it('keeps a frontal face mode when a pose model also supplies the full body skeleton', () => {
    const frontalWithBody: ImageAnalysis = {
      ...frontalAnalysis(),
      landmarks: [
        ...(frontalAnalysis().landmarks ?? []),
        bodyLandmark('neck-base', 'neck-base', 10, 13),
        bodyLandmark('shoulder', 'shoulder', 7, 13),
        bodyLandmark('back-middle', 'back-middle', 10, 14),
        bodyLandmark('tail-root', 'tail-root', 13, 15),
        bodyLandmark('hip', 'hip', 12, 15),
        bodyLandmark('front-knee', 'front-knee', 8, 16),
        bodyLandmark('front-paw', 'front-paw', 8, 18),
        bodyLandmark('rear-knee', 'rear-knee', 11, 16),
        bodyLandmark('rear-paw', 'rear-paw', 11, 18),
        bodyLandmark('tail-tip', 'tail-tip', 16, 16),
      ],
    }
    const activeMask = mask((values) => {
      for (let y = 6; y <= 18; y += 1) {
        for (let x = 5; x <= 14; x += 1) set(values, x, y)
      }
      line(values, 6, 2, 7, 6)
      line(values, 13, 2, 12, 6)
      line(values, 13, 15, 16, 16)
    })

    const result = evaluatePetPoseStructure({
      analysis: frontalWithBody,
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      activeMask,
      width,
      height,
    })

    assert.equal(result.mode, 'frontal')
    assert.ok(result.muzzleStructure >= 0.55)
    assert.ok(result.muzzleSeparationCells >= 3)
    assert.equal(result.frontVerticalRunRatio, 0)
  })

  it('keeps frontal geometry stable when the eye line rotates by fifteen or thirty degrees', () => {
    const analysis = largeFrontalAnalysis()
    const activeMask = faceMask()
    const baseline = evaluateLargeFace(analysis, activeMask)

    for (const angle of [-30, -15, 15, 30]) {
      const rotated = evaluateLargeFace(
        rotateFaceAnalysis(analysis, angle),
        rotateFaceMask(activeMask, angle),
      )

      assert.equal(rotated.mode, 'frontal')
      assert.ok(
        Math.abs(rotated.score - baseline.score) <= 0.03,
        JSON.stringify({
          angle,
          baseline: {
            score: baseline.score,
            ear: baseline.earStructure,
            muzzle: baseline.muzzleStructure,
            symmetry: baseline.boundaryRhythm,
            coverage: baseline.landmarkCoverage,
          },
          rotated: {
            score: rotated.score,
            ear: rotated.earStructure,
            muzzle: rotated.muzzleStructure,
            symmetry: rotated.boundaryRhythm,
            coverage: rotated.landmarkCoverage,
          },
        }),
      )
      assert.ok(
        Math.abs(rotated.muzzleStructure - baseline.muzzleStructure) <= 0.05,
        JSON.stringify({ angle, baseline: baseline.muzzleStructure, rotated: rotated.muzzleStructure }),
      )
    }
  })

  it('keeps face pose and score stable under horizontal mirroring', () => {
    const analysis = largeFrontalAnalysis()
    const activeMask = faceMask()
    const baseline = evaluateLargeFace(analysis, activeMask)
    const mirrored = evaluateLargeFace(
      mirrorFaceAnalysis(analysis),
      mirrorFaceMask(activeMask),
    )

    assert.equal(mirrored.mode, baseline.mode)
    assert.ok(Math.abs(mirrored.score - baseline.score) <= 1e-9)
    assert.ok(Math.abs(mirrored.muzzleStructure - baseline.muzzleStructure) <= 1e-9)
  })

  it('routes a three-quarter face through oblique facial geometry', () => {
    const analysis = largeFrontalAnalysis()
    const oblique: ImageAnalysis = {
      ...analysis,
      landmarks: (analysis.landmarks ?? []).map((landmark) => {
        if (landmark.structuralRole === 'nose-tip') return { ...landmark, x: 36 }
        if (landmark.id === 'left-mouth-corner') return { ...landmark, x: 33 }
        if (landmark.id === 'right-mouth-corner') return { ...landmark, x: 39 }
        return landmark
      }),
    }

    const result = evaluateLargeFace(oblique, faceMask())

    assert.equal(result.mode, 'oblique')
    assert.ok(result.muzzleStructure >= 0.7, result.muzzleStructure.toString())
    assert.ok(result.score >= 0.55, result.score.toString())
  })

  it('routes a laterally displaced nose to profile body geometry', () => {
    const analysis = largeFrontalAnalysis()
    const profile: ImageAnalysis = {
      ...analysis,
      landmarks: [
        ...(analysis.landmarks ?? []).map((landmark) => {
          if (landmark.structuralRole === 'nose-tip') return { ...landmark, x: 46, y: 34 }
          if (landmark.id === 'left-mouth-corner') return { ...landmark, x: 44, y: 37 }
          if (landmark.id === 'right-mouth-corner') return { ...landmark, x: 48, y: 38 }
          return landmark
        }),
        bodyLandmark('neck-base', 'neck-base', 36, 40),
        bodyLandmark('shoulder', 'shoulder', 38, 42),
        bodyLandmark('back-middle', 'back-middle', 30, 44),
        bodyLandmark('tail-root', 'tail-root', 20, 46),
        bodyLandmark('hip', 'hip', 24, 48),
        bodyLandmark('front-knee', 'front-knee', 39, 51),
        bodyLandmark('front-paw', 'front-paw', 40, 58),
        bodyLandmark('rear-knee', 'rear-knee', 27, 52),
        bodyLandmark('rear-paw', 'rear-paw', 25, 58),
        bodyLandmark('tail-tip', 'tail-tip', 12, 48),
        bodyLandmark('upper-jaw-end', 'upper-jaw', 44, 35),
        bodyLandmark('lower-jaw-end', 'lower-jaw', 44, 38),
      ],
    }
    const activeMask = faceMask()
    for (let y = 38; y <= 58; y += 1) {
      for (let x = 18; x <= 41; x += 1) setFaceCell(activeMask, x, y)
    }
    faceLine(activeMask, 32, 34, 46, 34)
    faceLine(activeMask, 20, 46, 12, 48)

    const result = evaluateLargeFace(profile, activeMask)

    assert.equal(result.mode, 'profile')
    assert.equal(result.available, true)
  })

  it('keeps a short feline muzzle strong when the nose sits close to the eye line', () => {
    const analysis = largeFrontalAnalysis()
    const shortMuzzle: ImageAnalysis = {
      ...analysis,
      landmarks: (analysis.landmarks ?? []).map((landmark) => {
        if (landmark.id === 'left-eye-center') return { ...landmark, x: 24, y: 31 }
        if (landmark.id === 'right-eye-center') return { ...landmark, x: 40, y: 31 }
        if (landmark.structuralRole === 'nose-tip') return { ...landmark, x: 32, y: 33 }
        if (landmark.id === 'left-mouth-corner') return { ...landmark, x: 28, y: 35 }
        if (landmark.id === 'right-mouth-corner') return { ...landmark, x: 36, y: 35 }
        return landmark
      }),
    }

    const result = evaluateLargeFace(shortMuzzle, faceMask())

    assert.equal(result.mode, 'frontal')
    assert.ok(result.muzzleStructure >= 0.82, result.muzzleStructure.toString())
  })

  it('ranks an articulated sitting profile above a fused column silhouette', () => {
    const articulated = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 13, 4, 12, 6)
      line(values, 12, 6, 13, 12)
      line(values, 13, 12, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const fused = mask((values) => {
      for (let y = 6; y <= 17; y += 1) {
        for (let x = 5; x <= 13; x += 1) set(values, x, y)
      }
      line(values, 13, 4, 13, 17)
      line(values, 5, 8, 2, 10)
    })
    const common = {
      analysis: analysis(),
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const clear = evaluatePetPoseStructure({ ...common, activeMask: articulated })
    const collapsed = evaluatePetPoseStructure({ ...common, activeMask: fused })

    assert.ok(clear.confidence >= 0.8)
    assert.ok(clear.negativeSpace > collapsed.negativeSpace + 0.3)
    assert.ok(clear.boundaryRhythm > collapsed.boundaryRhythm + 0.25)
    assert.ok(clear.score > collapsed.score + 0.15)
  })

  it('penalizes a long near-vertical chest column even when the edge alternates adjacent columns', () => {
    const articulated = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 13, 4, 12, 6)
      line(values, 12, 6, 10, 10)
      line(values, 10, 10, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const stripedColumn = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      for (let y = 6; y <= 17; y += 1) {
        const edge = y % 2 === 0 ? 12 : 13
        for (let x = 5; x <= edge; x += 1) set(values, x, y)
      }
      line(values, 5, 8, 2, 10)
    })
    const common = {
      analysis: analysis(),
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const clear = evaluatePetPoseStructure({ ...common, activeMask: articulated })
    const collapsed = evaluatePetPoseStructure({ ...common, activeMask: stripedColumn })
    const clearRatio = (clear as typeof clear & { frontVerticalRunRatio: number }).frontVerticalRunRatio
    const collapsedRatio = (collapsed as typeof collapsed & { frontVerticalRunRatio: number }).frontVerticalRunRatio

    assert.ok(clearRatio <= 0.45)
    assert.ok(collapsedRatio >= 0.7)
    assert.ok(clear.boundaryRhythm > collapsed.boundaryRhythm + 0.2)
  })

  it('rewards tail-root to tail-tip connectivity with decreasing width at 32, 48, and 64 cells', () => {
    for (const size of [32, 48, 64]) {
      const values = (tapered: boolean): Uint8Array => {
        const result = new Uint8Array(size * size)
        const start = { x: Math.round(size * 0.68), y: Math.round(size * 0.4) }
        const end = { x: Math.round(size * 0.18), y: Math.round(size * 0.62) }
        const axisX = end.x - start.x
        const axisY = end.y - start.y
        const squaredSpan = axisX * axisX + axisY * axisY
        const scale = size / 32
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const amount = Math.max(0, Math.min(1,
              ((x - start.x) * axisX + (y - start.y) * axisY) / squaredSpan))
            const centerX = start.x + axisX * amount
            const centerY = start.y + axisY * amount
            const radius = tapered
              ? Math.max(0.45, (2.8 * (1 - amount) + 0.35) * scale)
              : 1.65 * scale
            if (Math.hypot(x - centerX, y - centerY) <= radius) result[y * size + x] = 1
          }
        }
        for (let y = Math.round(size * 0.25); y <= Math.round(size * 0.56); y += 1) {
          for (let x = Math.round(size * 0.6); x <= Math.round(size * 0.82); x += 1) {
            result[y * size + x] = 1
          }
        }
        return result
      }
      const point = (x: number, y: number): readonly [number, number] => [
        Math.round(size * x),
        Math.round(size * y),
      ]
      const dynamicLandmark = (
        id: string,
        structuralRole: NonNullable<ImageLandmark['structuralRole']>,
        location: readonly [number, number],
      ): ImageLandmark => bodyLandmark(id, structuralRole, location[0], location[1])
      const tailRoot = point(0.68, 0.4)
      const tailTip = point(0.18, 0.62)
      const dynamicAnalysis: ImageAnalysis = {
        imageType: 'pet',
        landmarks: [
          dynamicLandmark('shoulder', 'shoulder', point(0.72, 0.32)),
          dynamicLandmark('tail-root', 'tail-root', tailRoot),
          dynamicLandmark('front-paw', 'front-paw', point(0.76, 0.82)),
          dynamicLandmark('rear-paw', 'rear-paw', point(0.62, 0.82)),
          dynamicLandmark('tail-tip', 'tail-tip', tailTip),
        ],
      }
      const common = {
        analysis: dynamicAnalysis,
        crop: { x: 0, y: 0, width: size, height: size },
        fit: { x: 0, y: 0, width: size, height: size },
        width: size,
        height: size,
      }
      const tapered = evaluatePetPoseStructure({ ...common, activeMask: values(true) })
      const constant = evaluatePetPoseStructure({ ...common, activeMask: values(false) })

      assert.ok(tapered.tailPathQuality > constant.tailPathQuality + 0.12, `${size} grid ignored tail taper`)
    }
  })

  it('scores a connected three-cell ear and two-cell muzzle above collapsed profile features', () => {
    const detailed = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 14, 2, 13, 4)
      line(values, 17, 5, 16, 6)
      line(values, 17, 5, 16, 8)
      line(values, 13, 4, 12, 6)
      line(values, 12, 6, 13, 12)
      line(values, 13, 12, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const collapsed = detailed.slice()
    set(collapsed, 14, 2)
    collapsed[3 * width + 14] = 0
    collapsed[4 * width + 13] = 0
    collapsed[7 * width + 16] = 0
    collapsed[8 * width + 16] = 0
    const common = {
      analysis: analysis(),
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const preserved = evaluatePetPoseStructure({ ...common, activeMask: detailed })
    const lost = evaluatePetPoseStructure({ ...common, activeMask: collapsed })
    const preservedDetails = preserved as typeof preserved & { earStructure: number; muzzleStructure: number }
    const lostDetails = lost as typeof lost & { earStructure: number; muzzleStructure: number }

    assert.ok(preservedDetails.earStructure >= 0.8)
    assert.ok(preservedDetails.muzzleStructure >= 0.8)
    assert.ok(preservedDetails.earStructure > lostDetails.earStructure + 0.35)
    assert.ok(preservedDetails.muzzleStructure > lostDetails.muzzleStructure + 0.25)
  })

  it('scores exposed ear and muzzle structure above the same landmarks embedded in a solid head', () => {
    const exposed = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 14, 2, 13, 4)
      line(values, 17, 5, 16, 6)
      line(values, 17, 5, 16, 8)
      line(values, 13, 4, 12, 6)
      line(values, 12, 6, 13, 12)
      line(values, 13, 12, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const embedded = exposed.slice()
    for (let y = 2; y <= 10; y += 1) {
      for (let x = 5; x <= 17; x += 1) set(embedded, x, y)
    }
    const common = {
      analysis: analysis(),
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const exposedScore = evaluatePetPoseStructure({ ...common, activeMask: exposed })
    const embeddedScore = evaluatePetPoseStructure({ ...common, activeMask: embedded })

    assert.ok(
      exposedScore.earStructure > embeddedScore.earStructure + 0.2,
      JSON.stringify({ exposed: exposedScore.earStructure, embedded: embeddedScore.earStructure }),
    )
    assert.ok(exposedScore.muzzleStructure > embeddedScore.muzzleStructure + 0.2)
    assert.ok(exposedScore.score > embeddedScore.score + 0.08)
  })

  it('scores a drooping ear through its connected geodesic path when the tip sits below the root', () => {
    const baseAnalysis = analysis()
    const droopingAnalysis: ImageAnalysis = {
      ...baseAnalysis,
      landmarks: (baseAnalysis.landmarks ?? []).map((landmark) => {
        if (landmark.structuralRole === 'ear-root') return { ...landmark, x: 14, y: 4 }
        if (landmark.structuralRole === 'ear-tip') return { ...landmark, x: 17, y: 11 }
        return landmark
      }),
    }
    const connected = mask((values) => {
      for (let y = 6; y <= 10; y += 1) {
        for (let x = 5; x <= 12; x += 1) set(values, x, y)
      }
      line(values, 13, 4, 12, 6)
      for (const [x, y] of [
        [14, 4], [15, 4], [16, 5], [17, 6], [18, 7],
        [18, 8], [18, 9], [18, 10], [17, 11],
      ] as const) set(values, x, y)
      line(values, 12, 6, 13, 12)
      line(values, 13, 12, 13, 17)
      line(values, 6, 10, 8, 13)
      line(values, 8, 13, 7, 17)
      line(values, 5, 8, 2, 10)
    })
    const disconnected = connected.slice()
    for (const [x, y] of [[16, 5], [17, 6], [18, 7]] as const) {
      disconnected[y * width + x] = 0
    }
    const common = {
      analysis: droopingAnalysis,
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
    }

    const preserved = evaluatePetPoseStructure({ ...common, activeMask: connected })
    const broken = evaluatePetPoseStructure({ ...common, activeMask: disconnected })
    const preservedEar = (preserved as typeof preserved & { earStructure: number }).earStructure
    const brokenEar = (broken as typeof broken & { earStructure: number }).earStructure

    assert.ok(17 > 4)
    assert.ok(preservedEar >= 0.8, preservedEar.toString())
    assert.ok(preservedEar > brokenEar + 0.35)
  })

  it('reports zero confidence when canonical quadruped roles are absent', () => {
    const result = evaluatePetPoseStructure({
      analysis: { imageType: 'pet', landmarks: [] },
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      activeMask: new Uint8Array(width * height),
      width,
      height,
    })

    assert.equal((result as typeof result & { available?: boolean }).available, false)
    assert.equal(result.confidence, 0)
    assert.equal(result.score, 0)
  })

})
