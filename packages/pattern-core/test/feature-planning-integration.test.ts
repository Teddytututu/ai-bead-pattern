import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type MaterialPalette,
  type PatternCandidate,
  type PatternGenerationResult,
  type PixelImage,
} from '../src/index.js'
import {
  validatePalettePlan,
  validateStructurePlan,
  validateValuePlan,
} from '../src/experimental.js'

const palette: MaterialPalette = {
  id: 'feature-test',
  name: 'Feature test',
  colors: [
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'skin', name: 'Skin', hex: '#d7a98c', rgb: [215, 169, 140] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
  ],
}

function portrait(): PixelImage {
  const width = 16
  const height = 16
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 215
    data[index * 4 + 1] = 169
    data[index * 4 + 2] = 140
    data[index * 4 + 3] = 255
  }
  return { width, height, data }
}

function halfMask(width: number, height: number, side: 'left' | 'right'): Float32Array {
  return Float32Array.from({ length: width * height }, (_, index) => {
    const x = index % width
    return side === 'left' ? Number(x < width / 2) : Number(x >= width / 2)
  })
}

function candidate(result: PatternGenerationResult): PatternCandidate {
  const value = result.recommended ?? result.bestEffort
  if (value === undefined) throw new Error(`Expected a candidate, received ${result.status}`)
  return value
}

describe('feature planning pipeline integration', () => {
  it('resolves eyes and mouth before cleanup and protects every occupied feature cell', async () => {
    const source = portrait()
    const faceValues = new Float32Array(source.width * source.height).fill(1)
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        subjectMask: { width: source.width, height: source.height, values: faceValues },
        semanticRegions: [{
          id: 'face-skin',
          label: 'face-skin',
          mask: { width: source.width, height: source.height, values: faceValues },
          confidence: 1,
        }],
        landmarks: [
          { id: 'left-eye-center', kind: 'eye', x: 5, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'right-eye-center', kind: 'eye', x: 11, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'mouth-center', kind: 'mouth', x: 8, y: 10, confidence: 1, priority: 'hard', carrierRegionId: 'face-skin' },
        ],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame' },
        optimization: { refinementMode: 'quality' },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['simple'],
      },
    })
    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate !== undefined)
    assert.ok(candidate.structurePlan !== undefined)
    assert.doesNotThrow(() => validateStructurePlan(candidate.structurePlan!))
    assert.ok(candidate.valuePlan !== undefined)
    assert.doesNotThrow(() => validateValuePlan(candidate.valuePlan!))
    assert.ok(candidate.palettePlan !== undefined)
    assert.doesNotThrow(() => validatePalettePlan(candidate.palettePlan!))
    assert.equal(candidate.pattern.cells.every((cell) =>
      candidate.palettePlan!.selectedColorIds.includes(cell.colorId)), true)
    assert.ok(candidate.metrics.valueOrderAccuracy >= 0
      && candidate.metrics.valueOrderAccuracy <= 1)
    assert.ok(candidate.metrics.paletteRoleConsistency >= 0
      && candidate.metrics.paletteRoleConsistency <= 1)
    assert.equal(candidate.gridRefinement?.mode, 'quality')
    assert.ok(candidate.gridRefinement!.energyAfter <= candidate.gridRefinement!.energyBefore)
    assert.equal(candidate.metrics.gridRefinementChanges, candidate.gridRefinement!.changedCells)
    assert.ok(candidate.metrics.symmetryQuality >= 0 && candidate.metrics.symmetryQuality <= 1)
    assert.deepEqual(candidate.featurePlacements?.map((entry) => entry.featureId), [
      'left-eye-center',
      'mouth-center',
      'right-eye-center',
    ])
    const occupied = new Set(candidate.featurePlacements?.flatMap((entry) => entry.occupiedCells))
    assert.equal(occupied.size > 0, true)
    const featureEdits = candidate.edits.filter((edit) => edit.reason === 'feature-placement')
    assert.equal(featureEdits.length > 0, true)
    assert.equal(candidate.edits.some((edit) =>
      edit.reason !== 'feature-placement'
        && occupied.has(edit.y * candidate.pattern.width + edit.x)), false)
    for (const edit of featureEdits) {
      assert.equal(candidate.pattern.cells.find((entry) =>
        entry.x === edit.x && entry.y === edit.y)?.colorId, edit.toColorId)
    }
  })

  it('lands pet ear tips, nose, markings, and a thin endpoint without collisions', async () => {
    const source = portrait()
    const carrierValues = new Float32Array(source.width * source.height).fill(1)
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        imageType: 'pet',
        subjectMask: { width: source.width, height: source.height, values: carrierValues },
        semanticRegions: [{
          id: 'pet-body', label: 'pet-body',
          mask: { width: source.width, height: source.height, values: carrierValues }, confidence: 1,
        }],
        landmarks: [
          { id: 'left-ear-tip', kind: 'ear', x: 4, y: 3, confidence: 1, priority: 'hard', symmetryGroup: 'ears', carrierRegionId: 'pet-body' },
          { id: 'right-ear-tip', kind: 'ear', x: 12, y: 3, confidence: 1, priority: 'hard', symmetryGroup: 'ears', carrierRegionId: 'pet-body' },
          { id: 'pet-nose', kind: 'nose', x: 8, y: 8, confidence: 1, priority: 'hard', carrierRegionId: 'pet-body' },
          { id: 'face-mark', kind: 'identity-mark', x: 6, y: 7, confidence: 1, priority: 'hard', carrierRegionId: 'pet-body' },
          { id: 'tail-endpoint', kind: 'custom', x: 14, y: 12, confidence: 1, priority: 'hard', carrierRegionId: 'pet-body' },
        ],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame' },
        optimization: { refinementMode: 'quality' },
        maxColors: 3, maxCandidates: 1, styles: ['simple'],
      },
    })

    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate !== undefined)
    assert.deepEqual(candidate.featurePlacements?.map((entry) => entry.featureId), [
      'face-mark', 'left-ear-tip', 'pet-nose', 'right-ear-tip', 'tail-endpoint',
    ])
    const occupied = candidate.featurePlacements!.flatMap((entry) => entry.occupiedCells)
    assert.equal(new Set(occupied).size, occupied.length)
    assert.equal(candidate.metrics.hardFeatureCompleteness, 1)
    assert.equal(candidate.metrics.featureCollisionCount, 0)
    assert.equal(candidate.metrics.featureSymmetryError, 0)
    assert.ok(candidate.metrics.symmetryQuality >= 0 && candidate.metrics.symmetryQuality <= 1)
    assert.equal(candidate.edits.some((edit) =>
      edit.reason !== 'feature-placement'
        && new Set(occupied).has(edit.y * candidate.pattern.width + edit.x)), false)
  })

  it('prefers specific portrait regions over the subject fallback for feature carriers', async () => {
    const source = portrait()
    const subjectValues = new Float32Array(source.width * source.height).fill(1)
    const faceValues = new Float32Array(source.width * source.height).fill(0.75)
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        subjectMask: { width: source.width, height: source.height, values: subjectValues },
        semanticRegions: [
          {
            id: 'subject',
            label: 'subject',
            mask: { width: source.width, height: source.height, values: subjectValues },
            confidence: 0.95,
          },
          {
            id: 'face-skin',
            label: 'face-skin',
            mask: { width: source.width, height: source.height, values: faceValues },
            confidence: 0.08,
          },
        ],
        landmarks: [
          { id: 'left-eye-center', kind: 'eye', x: 5, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'right-eye-center', kind: 'eye', x: 11, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'mouth-center', kind: 'mouth', x: 8, y: 10, confidence: 1, priority: 'hard', carrierRegionId: 'face-skin' },
        ],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame' },
        optimization: { refinementMode: 'quality' },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['simple'],
      },
    })

    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate !== undefined)
    assert.deepEqual(candidate.featurePlacements?.map((entry) => entry.featureId), [
      'left-eye-center',
      'mouth-center',
      'right-eye-center',
    ])
  })

  it('prefers an explicitly referenced instance region over an overlapping aggregate region', async () => {
    const source = portrait()
    const subjectValues = new Float32Array(source.width * source.height).fill(1)
    const faceValues = new Float32Array(source.width * source.height).fill(0)
    for (let y = 2; y <= 12; y += 1) {
      for (let x = 2; x <= 13; x += 1) faceValues[y * source.width + x] = 1
    }
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        imageType: 'pet',
        subjectMask: { width: source.width, height: source.height, values: subjectValues },
        semanticRegions: [
          {
            id: 'pet-face',
            label: 'pet faces',
            mask: { width: source.width, height: source.height, values: faceValues },
            confidence: 0.8,
          },
          {
            id: 'pet-01:pet-face',
            label: 'pet face',
            mask: { width: source.width, height: source.height, values: faceValues },
            confidence: 0.8,
          },
        ],
        landmarks: [
          { id: 'pet-01:left-eye-center', kind: 'eye', x: 5, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'pet-01:eyes', carrierRegionId: 'pet-01:pet-face' },
          { id: 'pet-01:right-eye-center', kind: 'eye', x: 11, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'pet-01:eyes', carrierRegionId: 'pet-01:pet-face' },
          { id: 'pet-01:nose-tip', kind: 'nose', x: 8, y: 9, confidence: 1, priority: 'hard', carrierRegionId: 'pet-01:pet-face' },
        ],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame' },
        optimization: { refinementMode: 'quality' },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['simple'],
      },
    })

    const generated = candidate(result)
    assert.deepEqual(generated.featurePlacements?.map((entry) => entry.featureId), [
      'pet-01:left-eye-center',
      'pet-01:nose-tip',
      'pet-01:right-eye-center',
    ])
    assert.equal(generated.metrics.hardFeatureCompleteness, 1)
  })

  it('keeps structural geometry active without flattening ordinary uploads into semantic color roles', async () => {
    const source = portrait()
    const subjectValues = new Float32Array(source.width * source.height).fill(1)
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        subjectMaskEvidence: {
          mask: { width: source.width, height: source.height, values: subjectValues },
          confidence: 1,
          source: 'ai',
          revision: 'ordinary-upload-1',
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        optimization: { refinementMode: 'quality' },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['simple'],
      },
    })

    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate !== undefined)
    assert.ok(candidate.structurePlan !== undefined)
    assert.ok(candidate.structurePlan.regions.length > 0)
    assert.ok(candidate.structurePlan.regions.every((region) => region.sourceRegionId === 'subject'))
    assert.equal(candidate.valuePlan, undefined)
    assert.equal(candidate.palettePlan, undefined)
    assert.equal(candidate.gridRefinement?.mode, 'quality')
    assert.equal(candidate.metrics.gridRefinementChanges, candidate.gridRefinement?.changedCells)
  })

  it('routes art-direction light direction and semantic materials into ValuePlan targets', async () => {
    const source = portrait()
    const left = halfMask(source.width, source.height, 'left')
    const right = halfMask(source.width, source.height, 'right')
    const generate = (lightDirection: readonly [number, number]) =>
      createPatternAlgorithm().generate({
        image: source,
        palette,
        analysis: {
          semanticRegions: [
            {
              id: 'metal-panel', label: 'metal',
              mask: { width: source.width, height: source.height, values: left }, confidence: 1,
            },
            {
              id: 'fabric-panel', label: 'fabric cloth',
              mask: { width: source.width, height: source.height, values: right }, confidence: 1,
            },
          ],
        },
        options: {
          canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
          structure: { occupancyMode: 'full-frame', valueLevels: 3 },
          artDirection: { lightDirection },
          maxColors: 3,
          maxCandidates: 1,
          styles: ['faithful'],
        },
      })
    const leftLit = candidate(await generate([-1, 0]))
    const rightLit = candidate(await generate([1, 0]))
    const topLit = candidate(await generate([0, -1]))
    const role = (entry: typeof leftLit, sourceRegionId: string, kind: 'base' | 'light') =>
      entry.valuePlan!.roles.find((valueRole) =>
        valueRole.id.includes(`:${sourceRegionId}|`) && valueRole.kind === kind)!

    assert.ok(leftLit.valuePlan !== undefined)
    assert.ok(rightLit.valuePlan !== undefined)
    assert.ok(role(leftLit, 'metal-panel', 'base').targetLightness
      > role(rightLit, 'metal-panel', 'base').targetLightness)
    assert.ok(role(topLit, 'metal-panel', 'light').targetLightness
      > role(topLit, 'fabric-panel', 'light').targetLightness)
  })

  it('routes palette inventory and substitutes into candidate palette selection', async () => {
    const source = portrait()
    const region = new Float32Array(source.width * source.height).fill(1)
    const inventoryPalette: MaterialPalette = {
      id: 'inventory-test',
      name: 'Inventory test',
      colors: [
        { id: 'skin-ideal', name: 'Skin ideal', hex: '#d7a98c', rgb: [215, 169, 140] },
        { id: 'skin-substitute', name: 'Skin substitute', hex: '#c99b80', rgb: [201, 155, 128] },
        { id: 'shadow', name: 'Shadow', hex: '#704f43', rgb: [112, 79, 67] },
      ],
      inventory: { 'skin-ideal': 0, 'skin-substitute': 256, shadow: 256 },
      substituteColorIds: { 'skin-ideal': ['skin-substitute'] },
    }
    const generate = (materialPalette: MaterialPalette) => createPatternAlgorithm().generate({
      image: source,
      palette: materialPalette,
      analysis: {
        semanticRegions: [{
          id: 'face-skin', label: 'skin',
          mask: { width: source.width, height: source.height, values: region }, confidence: 1,
        }],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame', valueLevels: 2 },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['faithful'],
      },
    })
    const unrestricted = candidate(await generate({
      id: inventoryPalette.id,
      name: inventoryPalette.name,
      colors: inventoryPalette.colors,
    }))
    const planned = candidate(await generate(inventoryPalette))

    assert.ok(planned.palettePlan !== undefined)
    assert.equal(unrestricted.palettePlan?.selectedColorIds.includes('skin-ideal'), true)
    assert.equal(planned.palettePlan.selectedColorIds.includes('skin-ideal'), false)
    assert.equal(planned.palettePlan.selectedColorIds.includes('skin-substitute'), true)
    assert.equal(planned.pattern.palette.some((color) => color.id === 'skin-ideal'), false)
    assert.equal(planned.pattern.cells.every((cell) => cell.colorId !== 'skin-ideal'), true)
  })
})
