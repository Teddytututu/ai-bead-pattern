import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createOpenClipScoringViews } from '../src/openclip-views.mjs'

function image(width = 6, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    data[offset] = 40 + index
    data[offset + 1] = 80 + index
    data[offset + 2] = 120 + index
    data[offset + 3] = 255
  }
  return { width, height, data }
}

function mask(width, height, activeCells) {
  const values = new Float32Array(width * height)
  for (const cell of activeCells) values[cell] = 1
  return { width, height, values }
}

function rectangleCells(width, x0, y0, x1, y1) {
  const cells = []
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    cells.push(y * width + x)
  }
  return cells
}

function landmark(id, kind, x, y, confidence = 1, extras = {}) {
  return {
    id,
    kind,
    x,
    y,
    confidence,
    priority: 'hard',
    observationState: 'observed',
    ...extras,
  }
}

function darkPixelCount(value) {
  let count = 0
  for (let index = 0; index < value.data.length; index += 4) {
    if (value.data[index] < 245 || value.data[index + 1] < 245 || value.data[index + 2] < 245) count += 1
  }
  return count
}

describe('OpenCLIP multi-view crops', () => {
  it('creates global, subject-mask, and face-mask views with bounded crops', () => {
    const referenceImage = image()
    const candidateImage = image()
    const subjectMask = mask(6, 4, [7, 8, 9, 13, 14, 15])
    const faceMask = mask(6, 4, [7, 8])
    const views = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceSubjectMask: subjectMask,
      candidateSubjectMask: subjectMask,
      referenceFaceMask: faceMask,
      candidateFaceMask: faceMask,
    })

    assert.deepEqual(views.map((view) => view.id), ['global', 'subject-mask', 'face-mask'])
    assert.equal(views[0].referenceImage, referenceImage)
    assert.equal(views[1].referenceImage.width, views[1].candidateImage.width)
    assert.equal(views[1].referenceImage.height, views[1].candidateImage.height)
    assert.equal(views[2].referenceImage.width, views[2].candidateImage.width)
    assert.equal(views[2].referenceImage.height, views[2].candidateImage.height)
    assert.equal(views[1].geometry.areaScaleRatio, 1)
    assert.equal(views[1].geometry.aspectRatioError, 0)
  })

  it('keeps a collapsed candidate small inside the shared proportional frame', () => {
    const referenceImage = image(10, 10)
    const candidateImage = image(10, 10)
    const referenceMask = mask(10, 10, [
      22, 23, 24, 25, 26, 27,
      32, 33, 34, 35, 36, 37,
      42, 43, 44, 45, 46, 47,
      52, 53, 54, 55, 56, 57,
      62, 63, 64, 65, 66, 67,
      72, 73, 74, 75, 76, 77,
    ])
    const candidateMask = mask(10, 10, [44, 45, 54, 55])
    const subject = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceSubjectMask: referenceMask,
      candidateSubjectMask: candidateMask,
    }).find((view) => view.id === 'subject-mask')
    assert.ok(subject)
    assert.equal(subject.referenceImage.width, subject.candidateImage.width)
    assert.ok(darkPixelCount(subject.referenceImage) > darkPixelCount(subject.candidateImage) * 4)
    assert.ok(subject.geometry.areaScaleRatio < 0.2)
    assert.ok(subject.geometry.retention < 0.6)
  })

  it('creates an aligned head-landmarks view across different source dimensions', () => {
    const referenceImage = image(12, 8)
    const candidateImage = image(24, 16)
    const referenceHeadLandmarks = [
      landmark('left-ear', 'ear', 3, 1, 0.9, { structuralRole: 'ear-tip' }),
      landmark('left-eye', 'eye', 4, 3, 0.9, { structuralRole: 'eye-center' }),
      landmark('nose', 'nose', 7, 4, 0.9, { structuralRole: 'nose-tip' }),
      landmark('chin', 'face-contour', 6, 6, 0.9),
    ]
    const candidateHeadLandmarks = referenceHeadLandmarks.map((entry) => ({
      ...entry,
      x: entry.x * 2,
      y: entry.y * 2,
    }))

    const head = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks,
      candidateHeadLandmarks,
    }).find((view) => view.id === 'head-landmarks')

    assert.ok(head)
    assert.equal(head.referenceImage.width, 224)
    assert.equal(head.referenceImage.height, 224)
    assert.equal(head.candidateImage.width, 224)
    assert.equal(head.candidateImage.height, 224)
    assert.ok(Math.abs(head.geometry.areaScaleRatio - 1) < 1e-12)
    assert.ok(head.geometry.aspectRatioError < 1e-12)
    assert.ok(head.geometry.centerOffset < 1e-12)
  })

  it('creates instance-scoped pet views without duplicating the global frame', () => {
    const referenceImage = image(12, 8)
    const candidateImage = image(12, 8)
    const subjectMask = mask(12, 8, rectangleCells(12, 1, 1, 10, 7))
    const faceMask = mask(12, 8, rectangleCells(12, 3, 1, 9, 5))
    const headLandmarks = [
      landmark('pet-01:left-ear', 'ear', 3, 1, 0.9, { structuralRole: 'ear-tip' }),
      landmark('pet-01:left-eye', 'eye', 4, 3, 0.9, { structuralRole: 'eye-center' }),
      landmark('pet-01:nose', 'nose', 7, 4, 0.9, { structuralRole: 'nose-tip' }),
    ]

    const views = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceSubjectMask: subjectMask,
      candidateSubjectMask: subjectMask,
      referenceFaceMask: faceMask,
      candidateFaceMask: faceMask,
      referenceHeadLandmarks: headLandmarks,
      candidateHeadLandmarks: headLandmarks,
      viewIdPrefix: 'pet-01',
      includeGlobal: false,
    })

    assert.deepEqual(views.map((view) => view.id), [
      'pet-01:subject-mask',
      'pet-01:face-mask',
      'pet-01:head-landmarks',
    ])
  })

  it('applies the candidate canvas crop to reference pixels, masks, and landmarks', () => {
    const referenceImage = image(20, 10)
    const candidateImage = image(10, 10)
    const referenceHeadLandmarks = [
      landmark('ear', 'ear', 12, 1, 0.9, { structuralRole: 'ear-tip' }),
      landmark('eye', 'eye', 14, 4, 0.9, { structuralRole: 'eye-center' }),
      landmark('nose', 'nose', 17, 5, 0.9, { structuralRole: 'nose-tip' }),
      landmark('chin', 'face-contour', 15, 8, 0.9),
    ]
    const candidateHeadLandmarks = referenceHeadLandmarks.map((entry) => ({
      ...entry,
      x: entry.x - 10,
    }))
    const views = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceCrop: { x: 10, y: 0, width: 10, height: 10 },
      referenceSubjectMask: mask(20, 10, rectangleCells(20, 10, 0, 20, 10)),
      candidateSubjectMask: mask(10, 10, rectangleCells(10, 0, 0, 10, 10)),
      referenceHeadLandmarks,
      candidateHeadLandmarks,
    })
    const subject = views.find((view) => view.id === 'subject-mask')
    const head = views.find((view) => view.id === 'head-landmarks')

    assert.equal(views[0].referenceImage.width, 10)
    assert.equal(views[0].referenceImage.height, 10)
    assert.ok(subject)
    assert.ok(head)
    assert.ok(Math.abs(subject.geometry.areaScaleRatio - 1) < 1e-12)
    assert.ok(subject.geometry.centerOffset < 1e-12)
    assert.ok(Math.abs(head.geometry.areaScaleRatio - 1) < 1e-12)
    assert.ok(head.geometry.centerOffset < 1e-12)
  })

  it('reports deterministic evidence confidence from observed and inferred head landmarks', () => {
    const referenceHeadLandmarks = [
      landmark('eye', 'eye', 2, 1, 0.8),
      landmark('ear', 'ear', 1, 0, 1),
    ]
    const candidateHeadLandmarks = [
      landmark('eye', 'eye', 2, 1, 0.6),
      landmark('ear', 'ear', 1, 0, 0.8, { observationState: 'inferred' }),
    ]
    const head = createOpenClipScoringViews({
      referenceImage: image(),
      candidateImage: image(),
      referenceHeadLandmarks,
      candidateHeadLandmarks,
      referenceSubjectConfidence: 0.8,
      candidateSubjectConfidence: 0.7,
      referenceFaceConfidence: 0.75,
      candidateFaceConfidence: 0.65,
    }).find((view) => view.id === 'head-landmarks')

    assert.ok(head)
    assert.ok(Math.abs(head.evidenceConfidence - 0.56) < 1e-12)
  })

  it('keeps erased ear and nose pixels visible to the head comparison', () => {
    const referenceImage = image(10, 10)
    const candidateImage = image(10, 10)
    const headLandmarks = [
      landmark('ear', 'ear', 2, 1, 0.9, { structuralRole: 'ear-tip' }),
      landmark('eye', 'eye', 4, 4, 0.9, { structuralRole: 'eye-center' }),
      landmark('nose', 'nose', 7, 5, 0.9, { structuralRole: 'nose-tip' }),
      landmark('chin', 'face-contour', 5, 8, 0.9),
    ]
    for (const point of headLandmarks.filter((entry) => entry.kind === 'ear' || entry.kind === 'nose')) {
      const offset = (point.y * candidateImage.width + point.x) * 4
      candidateImage.data[offset] = 255
      candidateImage.data[offset + 1] = 255
      candidateImage.data[offset + 2] = 255
    }
    const head = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: headLandmarks,
      candidateHeadLandmarks: headLandmarks,
    }).find((view) => view.id === 'head-landmarks')

    assert.ok(head)
    assert.ok(darkPixelCount(head.referenceImage) > darkPixelCount(head.candidateImage))
  })

  it('returns the global view when crop masks are absent or empty', () => {
    const referenceImage = image()
    const candidateImage = image()
    const empty = mask(6, 4, [])

    assert.deepEqual(
      createOpenClipScoringViews({ referenceImage, candidateImage }).map((view) => view.id),
      ['global'],
    )
    assert.deepEqual(createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceSubjectMask: empty,
      candidateSubjectMask: empty,
    }).map((view) => view.id), ['global'])
  })

  it('skips empty or missing head evidence and validates landmark confidence', () => {
    const referenceImage = image()
    const candidateImage = image()
    assert.deepEqual(createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: [],
      candidateHeadLandmarks: [],
    }).map((view) => view.id), ['global'])
    assert.deepEqual(createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: [landmark('missing-eye', 'eye', 1, 1, 0.8, { observationState: 'missing' })],
      candidateHeadLandmarks: [landmark('eye', 'eye', 1, 1)],
    }).map((view) => view.id), ['global'])
    assert.throws(() => createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: [landmark('eye', 'eye', 1, 1, 1.2)],
      candidateHeadLandmarks: [landmark('eye', 'eye', 1, 1)],
    }), /landmark confidence/i)
  })

  it('falls back from single-point and zero-span head evidence', () => {
    const referenceImage = image(10, 10)
    const candidateImage = image(10, 10)
    const single = landmark('nose', 'nose', 5, 5, 0.95, { structuralRole: 'nose-tip' })
    const collapsed = [
      landmark('left-eye', 'eye', 5, 5, 0.9, { structuralRole: 'eye-center' }),
      landmark('right-eye', 'eye', 5, 5, 0.9, { structuralRole: 'eye-center' }),
    ]

    assert.deepEqual(createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: [single],
      candidateHeadLandmarks: [single],
    }).map((view) => view.id), ['global'])
    assert.deepEqual(createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      referenceHeadLandmarks: collapsed,
      candidateHeadLandmarks: collapsed,
    }).map((view) => view.id), ['global'])
  })
})
