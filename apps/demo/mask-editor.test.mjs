import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import {
  composeMaskOverlay,
  createLiveStrokePreview,
  fitContainRect,
  maskEditSessionIsDirty,
  normalizePointerPoint,
  snapStrokeToBoundary,
} from './mask-editor.mjs'

function createRecordingCanvas(width = 2048, height = 2048) {
  const calls = []
  const context = {
    beginPath: () => calls.push(['beginPath']),
    arc: (...args) => calls.push(['arc', ...args]),
    fill: () => calls.push(['fill']),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    stroke: () => calls.push(['stroke']),
  }
  return {
    calls,
    canvas: {
      width,
      height,
      getContext: () => context,
    },
  }
}

function stroke(id, x = 0.5) {
  return {
    id,
    mode: 'add',
    points: [{ x, y: 0.5 }],
    radiusNormalized: 0.02,
  }
}

describe('demo mask editor helpers', () => {
  it('fits a rectangular source without stretching it', () => {
    assert.deepEqual(fitContainRect(400, 200, 300, 300), {
      x: 0,
      y: 75,
      width: 300,
      height: 150,
      scale: 0.75,
    })
  })

  it('maps and clamps pointer coordinates into source-normalized space', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }

    assert.deepEqual(normalizePointerPoint(300, 100, rect), { x: 0.5, y: 0.25 })
    assert.deepEqual(normalizePointerPoint(20, 500, rect), { x: 0, y: 1 })
  })

  it('shows AI occupancy, user additions, and user erasures as distinct overlays', () => {
    const base = new Float32Array([1, 0, 1, 0])
    const current = new Float32Array([1, 1, 0, 0])
    const overlay = composeMaskOverlay(base, current)

    assert.deepEqual([...overlay.slice(0, 4)], [24, 169, 133, 148])
    assert.deepEqual([...overlay.slice(4, 8)], [23, 126, 255, 224])
    assert.deepEqual([...overlay.slice(8, 12)], [236, 54, 63, 224])
    assert.deepEqual([...overlay.slice(12, 16)], [0, 0, 0, 0])
  })

  it('rejects mismatched mask buffers', () => {
    assert.throws(() => composeMaskOverlay(
      new Float32Array([1]),
      new Float32Array([1, 0]),
    ), /length/i)
  })

  it('draws only new live-preview segments within the pointer-move budget', () => {
    const { calls, canvas } = createRecordingCanvas()
    const preview = createLiveStrokePreview(canvas)
    const points = []
    const durations = []

    for (let index = 0; index < 100; index += 1) {
      points.push({ x: index / 100, y: index / 100 })
      const startedAt = performance.now()
      preview.draw(points, 'add', 0.02)
      durations.push(performance.now() - startedAt)
    }

    const lineSegments = calls.filter(([name]) => name === 'lineTo')
    const p95 = durations.toSorted((first, second) => first - second)[94]
    assert.equal(lineSegments.length, 99)
    assert.ok(p95 < 16, `Expected preview P95 below 16 ms, received ${p95.toFixed(3)} ms`)
  })

  it('marks session changes as pending until they match the confirmed session again', () => {
    const confirmed = {
      baseRevision: 'base-1',
      strokes: [stroke('one')],
      cursor: 1,
    }
    const undone = { ...confirmed, cursor: 0 }
    const redone = { ...confirmed, cursor: 1 }
    const appended = {
      ...confirmed,
      strokes: [...confirmed.strokes, stroke('two', 0.7)],
      cursor: 2,
    }

    assert.equal(maskEditSessionIsDirty(confirmed, confirmed), false)
    assert.equal(maskEditSessionIsDirty(undone, confirmed), true)
    assert.equal(maskEditSessionIsDirty(redone, confirmed), false)
    assert.equal(maskEditSessionIsDirty(appended, confirmed), true)
  })

  it('keeps portrait sources proportional inside a landscape workspace', () => {
    assert.deepEqual(fitContainRect(200, 400, 600, 300), {
      x: 225,
      y: 0,
      width: 150,
      height: 300,
      scale: 0.75,
    })
  })

  it('snaps a hand-drawn path toward a strong source boundary while keeping endpoints', () => {
    const width = 9
    const height = 9
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = x >= 4 ? 240 : 20
        const index = (y * width + x) * 4
        data[index] = value
        data[index + 1] = value
        data[index + 2] = value
        data[index + 3] = 255
      }
    }
    const result = snapStrokeToBoundary(
      [{ x: 0.2, y: 0.5 }, { x: 0.47, y: 0.5 }, { x: 0.51, y: 0.5 }, { x: 0.8, y: 0.5 }],
      { width, height, data },
      { maxDistanceNormalized: 0.12, endpointLock: 0.02 },
    )

    assert.deepEqual(result.points[0], { x: 0.2, y: 0.5 })
    assert.deepEqual(result.points.at(-1), { x: 0.8, y: 0.5 })
    assert.ok(Math.abs(result.points[1].x - 0.5) < 0.06)
    assert.ok(Math.abs(result.points[2].x - 0.5) < 0.06)
    assert.ok(result.snappedCount >= 2)
    assert.ok(result.confidence > 0.5)
  })

  it('wires the editor to the original evidence and saved edit session', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /import \{ createMaskEditorController \} from '\.\/mask-editor\.mjs'/)
    assert.match(html, /evidence: originalSubjectEvidence/)
    assert.match(html, /editSession: savedMaskEditSession/)
  })

  it('commits confirmed evidence before the single regeneration call', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')
    const confirmationBlock = html.slice(
      html.indexOf('onConfirm: async'),
      html.indexOf('function setStatus'),
    )

    assert.ok(confirmationBlock.indexOf('applyCorrectedSubjectEvidence(sourceAnalysis, evidence)') >= 0)
    assert.ok(confirmationBlock.indexOf('applyCorrectedSubjectEvidence(sourceAnalysis, evidence)')
      < confirmationBlock.indexOf('await generate()'))
    assert.equal(confirmationBlock.match(/await generate\(\)/g)?.length, 1)
  })

  it('keeps structure guidance enabled and exposes an outline comparison control', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')
    assert.match(html, /importanceStrength:\s*3\.5/)
    assert.match(html, /id="toggleOutlineButton"/)
    assert.match(html, /outline:\s*showOutline/)
  })
})
