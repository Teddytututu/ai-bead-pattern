import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  activeMaskStrokes,
  appendMaskEditStroke,
  applyMaskStroke,
  applyMaskStrokes,
  confirmMaskCorrection,
  confirmMaskEditSession,
  createMaskCorrectionDraft,
  createMaskCorrectionDraftFromSession,
  createMaskEditSession,
  numericArrayFingerprintSync,
  redoMaskEdit,
  undoMaskEdit,
  type BinaryMask,
  type MaskEditSession,
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
  it('adds and erases a solid circular brush without mutating the base mask', () => {
    const base = mask(5, 5, 0)
    const added = applyMaskStrokes(base, [stroke()])
    const erased = applyMaskStrokes(
      { width: 5, height: 5, values: new Float32Array(25).fill(1) },
      [stroke({ mode: 'erase' })],
    )

    assert.equal(base.values[12], 0)
    assert.equal(added.values[12], 1)
    assert.equal(added.values[11], 1)
    assert.equal(erased.values[12], 0)
    assert.equal(erased.values[11], 0)
  })

  it('turns a rough lasso into the complete connected subject component', () => {
    const values = new Float32Array(12 * 8)
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) values[y * 12 + x] = 1
      for (let x = 8; x <= 9; x += 1) values[y * 12 + x] = 1
    }
    const selected = applyMaskStrokes({ width: 12, height: 8, values }, [{
      id: 'rough-subject-lasso',
      mode: 'select',
      points: [
        { x: 0.08, y: 0.1 },
        { x: 0.58, y: 0.1 },
        { x: 0.58, y: 0.9 },
        { x: 0.08, y: 0.9 },
      ],
      radiusNormalized: 0.01,
    }])

    assert.equal(selected.values[3 * 12 + 3], 1)
    assert.equal(selected.values[3 * 12 + 8], 0)
    assert.equal([...selected.values].filter((value) => value === 1).length, 16)
  })

  it('fills the lasso interior when the automatic mask has no matching component', () => {
    const selected = applyMaskStrokes(mask(10, 10, 0), [{
      id: 'fallback-lasso',
      mode: 'select',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      radiusNormalized: 0.01,
    }])

    assert.equal(selected.values[5 * 10 + 5], 1)
    assert.equal(selected.values[0], 0)
  })

  it('stores a binary mask after confirmation', () => {
    const base = aiEvidence()
    base.mask.values[0] = 0.49
    base.mask.values[1] = 0.51

    const confirmed = confirmMaskCorrection(createMaskCorrectionDraft(base, [stroke()]))

    assert.equal([...confirmed.mask.values].every((value) => value === 0 || value === 1), true)
    assert.equal(confirmed.mask.values[0], 0)
    assert.equal(confirmed.mask.values[1], 1)
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

    assert.equal(confirmed.mask.values[6], 1)
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

  it('keeps undo and redo as a cursor over the complete stroke log', () => {
    const first = stroke({ id: 'first' })
    const second = stroke({ id: 'second', mode: 'erase' })
    const complete = appendMaskEditStroke(
      appendMaskEditStroke(createMaskEditSession('birefnet-1'), first),
      second,
    )
    const undone = undoMaskEdit(complete)
    const redone = redoMaskEdit(undone)

    assert.equal(complete.cursor, 2)
    assert.equal(undone.cursor, 1)
    assert.equal(undone.strokes.length, 2)
    assert.deepEqual(activeMaskStrokes(undone).map((entry) => entry.id), ['first'])
    assert.equal(redone.cursor, 2)
    assert.deepEqual(activeMaskStrokes(redone).map((entry) => entry.id), ['first', 'second'])
  })

  it('truncates the redo branch when a new stroke follows undo', () => {
    const session = createMaskEditSession('birefnet-1', [
      stroke({ id: 'first' }),
      stroke({ id: 'discarded' }),
    ])
    const branched = appendMaskEditStroke(
      undoMaskEdit(session),
      stroke({ id: 'replacement', points: [{ x: 0.25, y: 0.25 }] }),
    )

    assert.equal(branched.cursor, 2)
    assert.deepEqual(branched.strokes.map((entry) => entry.id), ['first', 'replacement'])
    assert.deepEqual(redoMaskEdit(branched), branched)
  })

  it('uses the session cursor for draft rendering and confirmed revision', () => {
    const complete = createMaskEditSession('birefnet-1', [
      stroke({ id: 'add', mode: 'add' }),
      stroke({ id: 'erase', mode: 'erase' }),
    ])
    const undone = undoMaskEdit(complete)
    const undoneDraft = createMaskCorrectionDraftFromSession(aiEvidence(), undone)
    const undoneEvidence = confirmMaskEditSession(aiEvidence(), undone)
    const redoneEvidence = confirmMaskEditSession(aiEvidence(), redoMaskEdit(undone))

    assert.equal(undoneDraft.mask.values[12], 1)
    assert.equal(undoneEvidence.mask.values[12], 1)
    assert.equal(redoneEvidence.mask.values[12], 0)
    assert.notEqual(undoneEvidence.revision, redoneEvidence.revision)
    assert.equal(
      redoneEvidence.revision,
      confirmMaskEditSession(aiEvidence(), complete).revision,
    )
  })

  it('replays the same session with the same mask and revision one hundred times', () => {
    const base = aiEvidence()
    const session = createMaskEditSession(base.revision, [
      stroke({ id: 'line', points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }] }),
      stroke({ id: 'trim', mode: 'erase', points: [{ x: 0.8, y: 0.2 }] }),
    ])
    const reference = confirmMaskEditSession(base, session)
    const referenceMask = numericArrayFingerprintSync(reference.mask.values)

    for (let replay = 0; replay < 100; replay += 1) {
      const result = confirmMaskEditSession(base, session)
      assert.equal(numericArrayFingerprintSync(result.mask.values), referenceMask)
      assert.equal(result.revision, reference.revision)
    }
  })

  it('changes revision for every persisted correction input', () => {
    const evidence = aiEvidence()
    const revisionFor = (base: SubjectMaskEvidence, strokes: readonly MaskStroke[]): string =>
      confirmMaskEditSession(base, createMaskEditSession(base.revision, strokes)).revision
    const changedBase = { ...aiEvidence(), revision: 'birefnet-2' }
    const revisions = [
      revisionFor(evidence, [stroke()]),
      revisionFor(evidence, [stroke({ mode: 'erase' })]),
      revisionFor(evidence, [stroke({ radiusNormalized: 0.2 })]),
      revisionFor(evidence, [stroke({ points: [{ x: 0.4, y: 0.5 }] })]),
      revisionFor(evidence, [stroke(), stroke({ id: 'second' })]),
      revisionFor(changedBase, [stroke()]),
    ]

    assert.equal(new Set(revisions).size, revisions.length)
  })

  it('keeps normalized brush area and center consistent across resolutions', () => {
    const normalizedStats = (size: number): { area: number; centerX: number; centerY: number } => {
      const result = applyMaskStrokes(mask(size, size, 0), [stroke({
        points: [{ x: 0.35, y: 0.65 }],
        radiusNormalized: 0.05,
      })])
      let count = 0
      let sumX = 0
      let sumY = 0
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if ((result.values[y * size + x] ?? 0) <= 0.5) continue
          count += 1
          sumX += x / Math.max(1, size - 1)
          sumY += y / Math.max(1, size - 1)
        }
      }
      return {
        area: count / (size * size),
        centerX: sumX / count,
        centerY: sumY / count,
      }
    }
    const results = [512, 1024, 2048].map(normalizedStats)

    for (const result of results) {
      assert.ok(Math.abs(result.area - results[0]!.area) < 0.001)
      assert.ok(Math.abs(result.centerX - 0.35) < 0.002)
      assert.ok(Math.abs(result.centerY - 0.65) < 0.002)
    }
  })

  it('rejects sessions that target another base revision or use an invalid cursor', () => {
    assert.throws(() => createMaskCorrectionDraftFromSession(
      aiEvidence(),
      createMaskEditSession('another-base'),
    ), /base revision/i)
    assert.throws(() => activeMaskStrokes({
      baseRevision: 'birefnet-1',
      strokes: [],
      cursor: 1,
    } as MaskEditSession), /cursor/i)
    assert.throws(() => createMaskEditSession('birefnet-1', [{
      ...stroke(),
      points: undefined,
    } as unknown as MaskStroke]), /points/i)
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
