import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planContours, resolveContourOptions, type ContourPlanningInput } from '../src/planning/contour-planner.js'
import { preferredContourColors, resolveContourColors, finalizeContourPlan } from '../src/planning/contour-planner.js'
import type { MaterialColor } from '../src/types.js'

function input(width = 9, height = 9): ContourPlanningInput {
  const subjectMask = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) subjectMask[y * width + x] = 1
  return { width, height, activeMask: new Uint8Array(width * height).fill(1), subjectMask,
    externalSource: 'subject-mask', regionIds: Array.from(subjectMask, (value, cell) => !value ? undefined : cell % width < width / 2 ? 'left-body' : 'right-body'),
    pixelLabs: Array.from(subjectMask, () => [50, 0, 0]), options: resolveContourOptions() }
}
describe('independent bead contours', () => {
  it('defaults both on and honors independent overrides including the legacy off switch', () => {
    assert.deepEqual(resolveContourOptions(), { external: true, internal: true, mode: 'full' })
    assert.equal(resolveContourOptions({ outlineMode: 'off' }).external, false)
    const external = planContours({ ...input(), options: resolveContourOptions({ contours: { internal: false } }) })
    const internal = planContours({ ...input(), options: resolveContourOptions({ contours: { external: false } }) })
    assert.ok(external.externalCells.length > 0); assert.equal(external.internalCells.length, 0)
    assert.ok(internal.internalCells.length > 0); assert.equal(internal.externalCells.length, 0)
    assert.deepEqual(planContours({ ...input(), options: resolveContourOptions({ outlineMode: 'off' }) }).externalCells, [])
  })
  it('owns an internal seam on only one side and does not outline quantized color clusters', () => {
    const request = input()
    const result = planContours({ ...request, options: resolveContourOptions({ contours: { external: false } }) })
    assert.equal(new Set(result.internalCells.map(cell => cell % request.width)).size, 1)
    assert.ok(result.internalCells.length >= 3)
    const sameSource = planContours({ ...request, regionIds: request.regionIds.map(id => id ? 'fur' : undefined) })
    assert.equal(sameSource.internalCells.length, 0)
    assert.equal(sameSource.diagnostics.internalSource, 'unavailable')
  })
  it('keeps occupancy intact and thins only boundary bands including holes and diagonal tips', () => {
    const request = input(11, 11)
    request.subjectMask![5 * 11 + 5] = 0
    request.subjectMask![0] = 1
    request.protectedEndpoints = new Set([0])
    const before = [...request.subjectMask!]
    const result = planContours(request)
    assert.deepEqual([...request.subjectMask!], before)
    assert.ok(result.externalCells.includes(0))
    assert.ok(result.externalCells.some(cell => [49, 59, 61, 71].includes(cell)))
    const selected = new Set(result.externalCells)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const block = [y * 11 + x, y * 11 + x + 1, (y + 1) * 11 + x, (y + 1) * 11 + x + 1]
      assert.ok(!block.every(cell => selected.has(cell)))
    }
  })
  it('reserves a moat around facial features and never draws an image-frame rectangle without evidence', () => {
    const request = input()
    const result = planContours({ ...request, featureCells: new Set([4 * 9 + 4]) })
    for (const cell of result.internalCells) assert.ok(Math.abs(cell % 9 - 4) > 1 || Math.abs(Math.floor(cell / 9) - 4) > 1)
    assert.ok(result.diagnostics.featureAvoidedCells > 0)
    const { subjectMask: _mask, ...withoutMask } = request
    const missing = planContours({ ...withoutMask, externalSource: 'unavailable' })
    assert.equal(missing.externalCells.length, 0)
    assert.ok(missing.diagnostics.warnings.includes('contour-subject-mask-unavailable'))
  })
  it('can select a lighter outline on dark material and protects colors through finalization', () => {
    const request = input()
    request.pixelLabs = request.pixelLabs.map(() => [10, 0, 0])
    const plan = planContours(request)
    const colors: MaterialColor[] = [10, 28, 90].map(l => ({ id: `l${l}`, name: `l${l}`, hex: '#222222', rgb: [34, 34, 34], lab: [l, 0, 0] }))
    const colorInput = { plan, pixelLabs: request.pixelLabs, activeMask: request.activeMask, colors }
    assert.ok(preferredContourColors(colorInput).includes('l28'))
    const resolved = resolveContourColors({ ...colorInput, initialColorIds: request.pixelLabs.map(() => 'l10') })
    assert.ok(Object.values(resolved.plan.colorByCell).every(id => id === 'l28'))
    const final = finalizeContourPlan(resolved.plan, resolved.colorIds, colors, request.activeMask)
    assert.equal(final.diagnostics.retainedCells, final.diagnostics.selectedCells)
    assert.equal(final.diagnostics.unresolvedContrastCells, 0)
    for (let cell = 0; cell < resolved.colorIds.length; cell++) if (resolved.plan.colorByCell[cell] === undefined) assert.equal(resolved.colorIds[cell], 'l10')
  })
  it('reports insufficient contrast instead of inventing a color or violating the source budget', () => {
    const request = input(), plan = planContours(request)
    const colors: MaterialColor[] = [{ id: 'same', name: 'same', hex: '#777777', rgb: [119, 119, 119], lab: [50, 0, 0] }]
    const result = resolveContourColors({ plan, colors, pixelLabs: request.pixelLabs, activeMask: request.activeMask, initialColorIds: request.pixelLabs.map(() => 'same') })
    assert.ok(result.plan.diagnostics.unresolvedContrastCells > 0)
    assert.equal(result.plan.diagnostics.sourceBudgetExceededCells, 0)
    assert.ok(result.colorIds.every(id => id === 'same'))
  })
})
