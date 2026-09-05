import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  outlinePlannerSchema,
  planContrastAwareOutline,
} from '../src/experimental.js'
import type { Lab } from '../src/index.js'

function squareFixture() {
  const width = 5
  const height = 5
  const activeMask = new Uint8Array(width * height).fill(1)
  const boundaryStrength = new Float32Array(width * height)
  const regionIds = new Int32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        boundaryStrength[y * width + x] = 1
      }
    }
  }
  return {
    width,
    height,
    activeMask,
    boundaryStrength,
    regionIds,
    pixelLabs: Array.from({ length: width * height }, () => [60, 0, 0] as Lab),
    importance: new Float32Array(width * height).fill(0.4),
  }
}

function outlineFixture(
  width: number,
  height: number,
  activeCells: readonly number[],
  protectedCells: readonly number[] = [],
) {
  const activeMask = new Uint8Array(width * height)
  const boundaryStrength = new Float32Array(width * height)
  const importance = new Float32Array(width * height)
  for (const cell of activeCells) {
    activeMask[cell] = 1
    boundaryStrength[cell] = 1
  }
  for (const cell of protectedCells) importance[cell] = 1
  return {
    width,
    height,
    activeMask,
    boundaryStrength,
    regionIds: new Int32Array(width * height),
    pixelLabs: Array.from({ length: width * height }, () => [50, 0, 0] as Lab),
    importance,
  }
}

describe('contrast-aware outline planning', () => {
  it('pins the PixelOE-derived method identity and license', () => {
    assert.equal(outlinePlannerSchema.id, 'contrast-aware-outline-v2')
    assert.deepEqual(outlinePlannerSchema.sources, [
      {
        repository: 'KohakuBlueleaf/PixelOE',
        revision: '341aa85048338d4d26c62fba23176e2b70d9f61b',
        license: 'Apache-2.0',
      },
      {
        repository: 'Orama-Interactive/Pixelorama',
        revision: '8ce32186e65ecb9cba6e3b26c5b837a1c66a4ad1',
        license: 'MIT',
      },
    ])
  })

  it('keeps full outlines one cell wide around the subject boundary', () => {
    const result = planContrastAwareOutline({
      ...squareFixture(),
      mode: 'full',
      lightDirection: [-1, -1],
    })

    assert.equal(result.diagnostics.candidateBoundaryCells, 16)
    assert.equal(result.diagnostics.selectedOutlineCells, 16)
    assert.equal(result.mask[2 * 5 + 2], 0)
    assert.equal(result.mask[0], 1)
    assert.equal(result.mask[4 * 5 + 4], 1)
  })

  it('opens quiet light-facing edges while retaining shadow-facing edges', () => {
    const result = planContrastAwareOutline({
      ...squareFixture(),
      mode: 'selective',
      lightDirection: [-1, -1],
    })

    assert.equal(result.mask[0], 0)
    assert.equal(result.mask[4 * 5 + 4], 1)
    assert.ok(result.diagnostics.openLightFacingCells > 0)
    assert.ok(result.diagnostics.selectedOutlineCells < result.diagnostics.candidateBoundaryCells)
  })

  it('retains a high-contrast identity edge and a protected light-facing anchor', () => {
    const fixture = squareFixture()
    const center = 2 * fixture.width + 2
    const lightAnchor = 0
    fixture.pixelLabs[center] = [8, 0, 0]
    fixture.boundaryStrength[center] = 1
    fixture.regionIds[center] = 1
    fixture.importance[lightAnchor] = 1

    const result = planContrastAwareOutline({
      ...fixture,
      mode: 'selective',
      lightDirection: [-1, -1],
    })

    assert.equal(result.mask[center], 1)
    assert.equal(result.mask[lightAnchor], 1)
    assert.ok(result.diagnostics.contrastRetainedCells > 0)
    assert.ok(result.diagnostics.importanceRetainedCells > 0)
  })

  it('returns an empty outline mask when the mode is off', () => {
    const result = planContrastAwareOutline({
      ...squareFixture(),
      mode: 'off',
      lightDirection: [-1, -1],
    })

    assert.equal(result.mask.some((value) => value === 1), false)
    assert.equal(result.diagnostics.selectedOutlineCells, 0)
  })

  it('removes a redundant one-cell L bridge while preserving the outline component', () => {
    const width = 5
    const result = planContrastAwareOutline({
      ...outlineFixture(width, 5, [
        1 * width + 1,
        1 * width + 2,
        2 * width + 2,
        2 * width + 3,
      ]),
      mode: 'full',
    })

    assert.equal(result.mask[1 * width + 2], 0)
    assert.ok(result.diagnostics.shortRunIrregularitiesBefore > 0)
    assert.equal(result.diagnostics.shortRunIrregularitiesAfter, 0)
    assert.equal(result.diagnostics.regularizedOutlineCells, 1)
    assert.equal(result.diagnostics.outlineComponentsBefore, 1)
    assert.equal(result.diagnostics.outlineComponentsAfter, 1)
  })

  it('removes a weak single-cell protrusion and retains a semantic endpoint', () => {
    const width = 5
    const spur = 1 * width + 2
    const active = [spur, 2 * width + 1, 2 * width + 2, 2 * width + 3]
    const regularized = planContrastAwareOutline({
      ...outlineFixture(width, 5, active),
      mode: 'full',
    })
    const protectedResult = planContrastAwareOutline({
      ...outlineFixture(width, 5, active, [spur]),
      mode: 'full',
    })

    assert.equal(regularized.mask[spur], 0)
    assert.equal(regularized.diagnostics.singleCellSpursBefore, 1)
    assert.equal(regularized.diagnostics.singleCellSpursAfter, 0)
    assert.equal(protectedResult.mask[spur], 1)
    assert.equal(protectedResult.diagnostics.protectedRhythmCells, 1)
  })

  it('keeps a closed outline when a pixel-perfect corner rewrite would open its hole', () => {
    const width = 5
    const ring = [
      1 * width + 1, 1 * width + 2, 1 * width + 3,
      2 * width + 1, 2 * width + 3,
      3 * width + 1, 3 * width + 2, 3 * width + 3,
    ]
    const result = planContrastAwareOutline({
      ...outlineFixture(width, 5, ring),
      mode: 'full',
    })

    assert.deepEqual([...result.mask], [...outlineFixture(width, 5, ring).activeMask])
    assert.equal(result.diagnostics.outlineHolesBefore, 1)
    assert.equal(result.diagnostics.outlineHolesAfter, 1)
    assert.ok(result.diagnostics.topologyRejectedEdits > 0)
  })
})
