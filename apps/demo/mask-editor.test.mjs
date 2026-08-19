import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import {
  composeMaskOverlay,
  fitContainRect,
  normalizePointerPoint,
} from './mask-editor.mjs'

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

    assert.deepEqual([...overlay.slice(0, 4)], [40, 125, 115, 92])
    assert.deepEqual([...overlay.slice(4, 8)], [36, 112, 185, 168])
    assert.deepEqual([...overlay.slice(8, 12)], [214, 83, 77, 168])
    assert.deepEqual([...overlay.slice(12, 16)], [0, 0, 0, 0])
  })

  it('rejects mismatched mask buffers', () => {
    assert.throws(() => composeMaskOverlay(
      new Float32Array([1]),
      new Float32Array([1, 0]),
    ), /length/i)
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

    assert.ok(confirmationBlock.indexOf('subjectMaskEvidence: evidence') >= 0)
    assert.ok(confirmationBlock.indexOf('subjectMaskEvidence: evidence') < confirmationBlock.indexOf('await generate()'))
    assert.equal(confirmationBlock.match(/await generate\(\)/g)?.length, 1)
  })
})
