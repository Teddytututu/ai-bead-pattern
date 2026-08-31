import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addLocalizedIssue,
  candidateIdentity,
  createPreferenceSession,
  exportPreferenceRecord,
  exportPreferenceSession,
  loadPreferenceSession,
  preferenceAxes,
  preferenceIssueTags,
  recordCandidateComparison,
  redoPreferenceEdit,
  savePreferenceSession,
  setCandidateAxisScore,
  setCandidateRanking,
  undoPreferenceEdit,
  updateLocalizedIssue,
} from './preference-workbench.mjs'

it('normalizes a missing candidate palette identity before preference learning', () => {
  const identity = candidateIdentity({
    id: 'candidate-1',
    generationId: 'generation-1',
    variantId: 'variant-1',
    style: 'faithful',
    pattern: {
      width: 32,
      height: 32,
      metadata: { algorithmVersion: '0.8.0' },
    },
    metrics: {},
  })

  assert.equal(identity.palette.id, 'unknown-palette')
  assert.equal(identity.palette.version, 'unknown')
})

function candidate(id, width = 32, height = 32) {
  return {
    id,
    generationId: 'generation-1',
    variantId: `variant-${id}`,
    style: 'faithful',
    pattern: { width, height },
    source: { route: 'deterministic', model: 'pattern-core', version: '0.7.0' },
    palette: { id: 'generic-24', version: '2026-08-31' },
    metrics: { silhouetteBoundaryIoU: 0.8, featureCoverage: 0.7 },
  }
}

describe('preference annotation workbench state', () => {
  it('creates a replayable session for two to four candidates', () => {
    const session = createPreferenceSession({
      generationId: 'generation-1',
      source: { id: 'source-1', kind: 'portrait', width: 640, height: 480 },
      annotatorId: 'anonymous-1',
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      createdAt: 1_725_062_400_000,
    })

    assert.equal(session.schemaVersion, 'preference-session-v2')
    assert.deepEqual(session.candidateOrder, ['a', 'b', 'c'])
    assert.equal(Object.keys(session.axisScores.a).length, preferenceAxes.length)
    assert.equal(preferenceIssueTags.length, 14)
    assert.equal(session.history.length, 0)
  })

  it('records axis scores and localized issues with bounded coordinates', () => {
    const initial = createPreferenceSession({
      generationId: 'generation-1', source: { id: 'source-1', kind: 'pet' },
      annotatorId: 'anonymous-1', candidates: [candidate('a'), candidate('b')], createdAt: 100,
    })
    const scored = setCandidateAxisScore(initial, 'a', 'identity', 4)
    const annotated = addLocalizedIssue(scored, {
      candidateId: 'a', tag: 'thin-structure-collapse', severity: 3, confidence: 0.85,
      note: 'tail tip', region: { x: 0.75, y: 0.2, width: 0.1, height: 0.15 },
      cells: [{ x: 30, y: 4 }], createdAt: 120,
    })

    assert.equal(annotated.axisScores.a.identity, 4)
    assert.equal(annotated.annotations[0].cells[0].x, 30)
    assert.equal(annotated.annotations[0].severity, 3)
    assert.throws(() => addLocalizedIssue(scored, {
      candidateId: 'a', tag: 'thin-structure-collapse', severity: 2, confidence: 0.8,
      cells: [{ x: 32, y: 0 }], createdAt: 121,
    }), /cell.*board/i)
  })

  it('supports annotation modification plus undo and redo', () => {
    const initial = createPreferenceSession({
      generationId: 'generation-1', source: { id: 'source-1', kind: 'object' },
      annotatorId: 'anonymous-1', candidates: [candidate('a'), candidate('b')], createdAt: 100,
    })
    const added = addLocalizedIssue(initial, {
      id: 'issue-1', candidateId: 'a', tag: 'jagged-contour', severity: 2,
      confidence: 0.7, cells: [{ x: 2, y: 3 }], createdAt: 110,
    })
    const updated = updateLocalizedIssue(added, 'issue-1', { severity: 3, note: 'jaw line' })
    const undone = undoPreferenceEdit(updated)
    const redone = redoPreferenceEdit(undone)

    assert.equal(updated.annotations[0].severity, 3)
    assert.equal(undone.annotations[0].severity, 2)
    assert.equal(redone.annotations[0].note, 'jaw line')
  })

  it('stores pairwise, tie, ranking, best, elimination, and composite outcomes', () => {
    let session = createPreferenceSession({
      generationId: 'generation-1', source: { id: 'source-1', kind: 'scene' },
      annotatorId: 'anonymous-1', candidates: [candidate('a'), candidate('b'), candidate('c')], createdAt: 100,
    })
    session = recordCandidateComparison(session, {
      candidateIds: ['a', 'b'], choice: 'tie', strengths: ['a', 'b'], createdAt: 130,
    })
    session = setCandidateRanking(session, {
      order: ['b', 'a', 'c'], bestCandidateId: 'b',
      eliminated: [{ candidateId: 'c', reasons: ['too-many-colors'] }],
      compositeCandidateIds: ['a', 'b'], updatedAt: 140,
    })

    assert.equal(session.comparisons[0].choice, 'tie')
    assert.deepEqual(session.ranking.order, ['b', 'a', 'c'])
    assert.equal(session.ranking.bestCandidateId, 'b')
    assert.deepEqual(session.ranking.compositeCandidateIds, ['a', 'b'])
  })

  it('restores deterministic JSON and JSONL exports from storage', () => {
    const values = new Map()
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    let session = createPreferenceSession({
      generationId: 'generation-1', source: { id: 'source-1', kind: 'portrait' },
      annotatorId: 'anonymous-1', candidates: [candidate('a'), candidate('b')], createdAt: 100,
    })
    session = setCandidateAxisScore(session, 'a', 'recognition', 5)
    savePreferenceSession(storage, session)

    const restored = loadPreferenceSession(storage, 'generation-1')
    const firstJson = exportPreferenceSession(restored, 'json')
    const secondJson = exportPreferenceSession(restored, 'json')
    const jsonl = exportPreferenceSession(restored, 'jsonl')

    assert.equal(firstJson, secondJson)
    assert.equal(JSON.parse(firstJson).generationId, 'generation-1')
    assert.equal(jsonl.trim().split('\n').length, 1)
    assert.equal(JSON.parse(jsonl).axisScores.a.recognition, 5)
  })

  it('exports the recoverable session through the strict V2 converter', () => {
    const session = createPreferenceSession({
      generationId: 'generation-1', source: { id: 'source-1', kind: 'portrait' },
      annotatorId: 'anonymous-1', candidates: [candidate('a'), candidate('b')], createdAt: 100,
    })
    const calls = []
    const converter = (input, options) => {
      calls.push({ input, options })
      return { schemaVersion: 2, id: options.recordId, generationId: input.generationId }
    }

    const json = exportPreferenceRecord(session, converter, 'json')
    const jsonl = exportPreferenceRecord(session, converter, 'jsonl')

    assert.equal(JSON.parse(json).schemaVersion, 2)
    assert.equal(JSON.parse(jsonl).id, 'workbench-generation-1-anonymous-1')
    assert.equal(calls[0].input.schemaVersion, 'preference-session-v2')
    assert.equal('history' in calls[0].input, false)
    assert.equal('future' in calls[0].input, false)
  })
})
