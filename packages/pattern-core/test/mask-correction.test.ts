import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyMaskStroke,
  applyMaskStrokes,
  confirmMaskCorrection,
  createMaskCorrectionDraft,
  type BinaryMask,
  type MaskStroke,
  type SubjectMaskEvidence,
} from '../src/index.js'

function mask(width: number, height: number, fill: number): BinaryMask {
  return { width, height, values: new Float32Array(width * height).fill(fill) }
}

function stroke(overrides: Partial<MaskStroke> = {}): MaskStroke {
  return {
    id: 'stroke-1',
    mode: 'add',
    points: [{ x: 0.5, y: 0.5 }],
    radiusNormalized: 0.4,
    ...overrides,
  }
}

function aiEvidence(): SubjectMaskEvidence {
  return {
    mask: mask(5, 5, 0),
    confidence: 0.42,
    source: 'ai',
    revision: 'birefnet-1',
    provenance: [{
      origin: 'model',
      provider: 'rembg-http',
      model: 'birefnet-general-lite',
      version: 'mask-v1',
    }],
  }
}

describe('mask correction engine', () => {
  it('adds and erases a soft circular brush without mutating the base mask', () => {
    const base = mask(5, 5, 0)
    const added = applyMaskStrokes(base, [stroke()])
    const erased = applyMaskStrokes(
      { width: 5, height: 5, values: new Float32Array(25).fill(1) },
      [stroke({ mode: 'erase' })],
    )

    assert.equal(base.values[12], 0)
    assert.equal(added.values[12], 1)
    assert.ok((added.values[11] ?? 0) > 0)
    assert.ok((added.values[11] ?? 0) < 1)
    assert.equal(erased.values[12], 0)
    assert.ok((erased.values[11] ?? 0) > 0)
    assert.ok((erased.values[11] ?? 0) < 1)
  })

  it('interpolates a continuous brush path between sparse pointer samples', () => {
    const corrected = applyMaskStrokes(mask(9, 3, 0), [stroke({
      points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
      radiusNormalized: 0.2,
    })])

    for (let x = 0; x < corrected.width; x += 1) {
      assert.ok((corrected.values[corrected.width + x] ?? 0) > 0.5)
    }
  })

  it('keeps draft edits separate until the user confirms them', () => {
    const base = aiEvidence()
    const draft = createMaskCorrectionDraft(base)
    const edited = applyMaskStroke(draft, stroke())

    assert.equal(base.userConfirmed, undefined)
    assert.equal(draft.strokes.length, 0)
    assert.notEqual(draft.baseEvidence.mask, base.mask)
    assert.equal(edited.strokes.length, 1)
    assert.equal(edited.mask.values[12], 1)
  })

  it('rebuilds confirmed evidence from the base mask and stroke log', () => {
    const edited = applyMaskStroke(createMaskCorrectionDraft(aiEvidence()), stroke())
    edited.mask.values[12] = 0.25

    const confirmed = confirmMaskCorrection(edited)

    assert.equal(confirmed.mask.values[12], 1)
  })

  it('creates deterministic confirmed evidence with model and manual provenance', () => {
    const first = confirmMaskCorrection(createMaskCorrectionDraft(aiEvidence(), [stroke()]))
    const second = confirmMaskCorrection(createMaskCorrectionDraft(aiEvidence(), [stroke()]))
    const changed = confirmMaskCorrection(createMaskCorrectionDraft(aiEvidence(), [stroke({
      points: [{ x: 0.25, y: 0.5 }],
    })]))

    assert.equal(first.revision, second.revision)
    assert.notEqual(first.revision, changed.revision)
    assert.equal(first.confidence, 0.42)
    assert.equal(first.source, 'ai+manual')
    assert.equal(first.userConfirmed, true)
    assert.deepEqual(
      first.provenance?.map((entry) => [entry.origin, entry.provider]),
      [['manual', 'mask-editor'], ['model', 'rembg-http']],
    )
  })

  it('allows a user to confirm the original model mask without painting', () => {
    const base = aiEvidence()
    base.mask.values[6] = 0.75
    const confirmed = confirmMaskCorrection(createMaskCorrectionDraft(base))

    assert.deepEqual(confirmed.mask.values, base.mask.values)
    assert.notEqual(confirmed.revision, base.revision)
    assert.equal(confirmed.userConfirmed, true)
    assert.equal(confirmed.source, 'ai+manual')
  })

  it('makes stroke order part of the revision and paint result', () => {
    const add = stroke({ id: 'add', mode: 'add' })
    const erase = stroke({ id: 'erase', mode: 'erase' })
    const addThenErase = confirmMaskCorrection(createMaskCorrectionDraft(aiEvidence(), [add, erase]))
    const eraseThenAdd = confirmMaskCorrection(createMaskCorrectionDraft(aiEvidence(), [erase, add]))

    assert.notEqual(addThenErase.revision, eraseThenAdd.revision)
    assert.equal(addThenErase.mask.values[12], 0)
    assert.equal(eraseThenAdd.mask.values[12], 1)
  })

  it('rejects malformed masks and stroke logs at the public boundary', () => {
    assert.throws(() => applyMaskStrokes(
      { width: 2, height: 2, values: new Float32Array(3) },
      [],
    ), /mask values length/i)
    assert.throws(() => applyMaskStrokes(mask(2, 2, 0), [stroke({
      radiusNormalized: 0,
    })]), /radiusNormalized/i)
    assert.throws(() => applyMaskStrokes(mask(2, 2, 0), [stroke({
      points: [{ x: 1.1, y: 0.5 }],
    })]), /points/i)
    assert.throws(() => applyMaskStrokes(mask(2, 2, 0), [
      stroke(),
      stroke({ points: [{ x: 0, y: 0 }] }),
    ]), /duplicate stroke id/i)
    assert.throws(() => applyMaskStrokes(mask(2, 2, 0), [{
      ...stroke(),
      points: undefined,
    } as unknown as MaskStroke]), /points/i)
    assert.throws(() => createMaskCorrectionDraft({
      ...aiEvidence(),
      revision: 3,
    } as unknown as SubjectMaskEvidence), /revision/i)
  })
})
