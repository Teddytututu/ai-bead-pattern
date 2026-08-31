import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPatternAlgorithm, type MaterialPalette, type PixelImage } from '../src/index.js'
import {
  applyArtDirectionImportance,
  enforceTileSeams,
  planPixelArtDirection,
  selectAnimationKeyFrame,
} from '../src/experimental.js'

const integrationPalette: MaterialPalette = {
  id: 'direction-palette', name: 'Direction palette', colors: [
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'red', name: 'Red', hex: '#cc3344', rgb: [204, 51, 68] },
    { id: 'yellow', name: 'Yellow', hex: '#e8c84a', rgb: [232, 200, 74] },
    { id: 'green', name: 'Green', hex: '#3b986b', rgb: [59, 152, 107] },
    { id: 'blue', name: 'Blue', hex: '#3775ad', rgb: [55, 117, 173] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
  ],
}

function multicolorImage(): PixelImage {
  const width = 8
  const height = 8
  const data = new Uint8ClampedArray(width * height * 4)
  const colors = integrationPalette.colors.map((color) => color.rgb)
  for (let index = 0; index < width * height; index += 1) {
    const color = colors[index % colors.length]!
    data[index * 4] = color[0]
    data[index * 4 + 1] = color[1]
    data[index * 4 + 2] = color[2]
    data[index * 4 + 3] = 255
  }
  return { width, height, data }
}

function focusedScene() {
  const width = 8
  const height = 8
  const data = new Uint8ClampedArray(width * height * 4)
  const background = new Float32Array(width * height)
  const subject = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const isSubject = x >= 5
      data[index * 4] = isSubject ? 55 : 204
      data[index * 4 + 1] = isSubject ? 117 : 51
      data[index * 4 + 2] = isSubject ? 173 : 68
      data[index * 4 + 3] = 255
      background[index] = isSubject ? 0 : 1
      subject[index] = isSubject ? 1 : 0
    }
  }
  return {
    image: { width, height, data } satisfies PixelImage,
    analysis: {
      semanticRegions: [
        { id: 'background', label: 'background', mask: { width, height, values: background }, confidence: 1, importance: 0.5 },
        { id: 'subject', label: 'subject', mask: { width, height, values: subject }, confidence: 1, importance: 0.5 },
      ],
    },
  }
}

describe('pixel art direction planning', () => {
  it('compresses background importance and boosts cells near the explicit focus', () => {
    const plan = planPixelArtDirection({
      width: 5, height: 1, style: 'faithful', imageType: 'landscape', subjectOccupancy: 0.4,
      focus: [0.9, 0.5], depthRange: [0, 1],
    })
    const result = applyArtDirectionImportance({
      plan,
      width: 5,
      height: 1,
      activeMask: new Uint8Array(5).fill(1),
      baseImportance: [1, 1, 1, 1, 1],
      semanticLabelsByCell: ['sky', 'background', 'middle water', 'subject', 'foreground subject'],
    })

    assert.ok(result.importance[0]! < 1)
    assert.ok(result.importance[4]! > result.importance[3]!)
    assert.ok(result.summary.backgroundCompressedCells >= 2)
    assert.ok(result.summary.focusEnhancedCells >= 1)
    assert.ok(result.summary.maximumFocusBoost > 0)
  })

  it('allocates more identity and texture detail as the grid grows', () => {
    const compact = planPixelArtDirection({
      width: 32, height: 32, style: 'simple', imageType: 'portrait',
      subjectOccupancy: 0.62, focus: [0.5, 0.35], semanticLabels: ['face', 'hair', 'background'],
    })
    const detailed = planPixelArtDirection({
      width: 64, height: 64, style: 'faithful', imageType: 'portrait',
      subjectOccupancy: 0.62, focus: [0.5, 0.35], semanticLabels: ['face', 'hair', 'background'],
    })

    assert.ok(detailed.detailBudget.identityCells > compact.detailBudget.identityCells)
    assert.ok(detailed.detailBudget.textureCells > compact.detailBudget.textureCells)
    assert.ok(compact.detailBudget.negativeSpaceCells > 0)
    assert.deepEqual(compact.focus, [0.5, 0.35])
  })

  it('creates distinct clear, delicate, retro, high-contrast, and soft profiles', () => {
    const styles = ['simple', 'faithful', 'cute', 'high-contrast', 'soft'] as const
    const plans = styles.map((style) => planPixelArtDirection({
      width: 48, height: 48, style, imageType: 'illustration', subjectOccupancy: 0.7,
    }))

    assert.equal(new Set(plans.map((plan) => plan.profile.id)).size, styles.length)
    assert.ok(plans[0]!.transitionBudget < plans[1]!.transitionBudget)
    assert.ok(plans[2]!.dither.patternDensity > plans[0]!.dither.patternDensity)
    assert.ok(plans[3]!.outline.shadowOpacity > plans[4]!.outline.shadowOpacity)
  })

  it('plans scene layers, material texture direction, and selective outlines', () => {
    const plan = planPixelArtDirection({
      width: 64, height: 48, style: 'faithful', imageType: 'landscape', subjectOccupancy: 0.58,
      semanticLabels: ['sky', 'water', 'vegetation', 'rock', 'building', 'glass', 'cloth'],
      lightDirection: [-0.6, -0.8], depthRange: [0.1, 0.9],
    })

    assert.deepEqual(plan.scene.layers.map((layer) => layer.id), ['background', 'middle', 'foreground'])
    assert.ok(plan.scene.occlusionBudget > 0)
    assert.equal(plan.materials.water.textureDirection, 'horizontal')
    assert.equal(plan.materials.wood.textureDirection, 'grain')
    assert.ok(plan.outline.shadowOpacity > plan.outline.lightOpacity)
    assert.deepEqual(plan.lightDirection, [-0.6, -0.8])
  })

  it('exposes tile seam contracts and animation frame consistency budgets', () => {
    const tile = planPixelArtDirection({
      width: 32, height: 32, style: 'simple', imageType: 'landscape', subjectOccupancy: 0.8,
      mode: 'tile', tileEdges: { top: 'grass', right: 'path', bottom: 'grass', left: 'path' },
    })
    const frame = planPixelArtDirection({
      width: 48, height: 48, style: 'cute', imageType: 'pet', subjectOccupancy: 0.55,
      mode: 'animation-frame', frame: { poseVisibility: 0.9, actionArc: 0.8, sharedPaletteId: 'pet-run-v1' },
    })

    assert.equal(tile.tile?.seamSignature, 'grass|path|grass|path')
    assert.ok((tile.tile?.variantBudget ?? 0) >= 4)
    assert.equal(frame.animation?.sharedPaletteId, 'pet-run-v1')
    assert.equal(frame.animation?.sharedGridId, '48x48')
    assert.ok((frame.animation?.keyFrameScore ?? 0) > 0.8)
    assert.ok((frame.animation?.gridConsistencyWeight ?? 0) >= 0.8)
  })

  it('enforces matching tile edges while preserving protected feature cells', () => {
    const result = enforceTileSeams({
      colorIds: [
        'red', 'blue', 'red',
        'red', 'red', 'red',
        'blue', 'red', 'blue',
      ],
      width: 3,
      height: 3,
      activeMask: new Uint8Array(9).fill(1),
      protectedCells: new Set([1]),
      tileEdges: { top: 'grass', right: 'path', bottom: 'grass', left: 'path' },
    })

    assert.equal(result.colorIds[1], 'blue')
    assert.equal(result.colorIds[7], 'blue')
    assert.equal(result.summary.mismatchesBefore, 3)
    assert.equal(result.summary.mismatchesAfter, 0)
    assert.equal(result.summary.protectedConflicts, 0)
    assert.ok(result.edits.length > 0)
    assert.ok(result.edits.every((edit) => edit.reason === 'tile-seam'))
  })

  it('selects a static animation key frame and preserves shared grid and palette identity', () => {
    const result = selectAnimationKeyFrame([
      {
        id: 'blurred-arc', silhouette: 0.82, featureVisibility: 0.72, actionArc: 0.96,
        blur: 0.8, occlusion: 0.25, sharedGridId: 'pet-48', sharedPaletteId: 'pet-run-v1',
      },
      {
        id: 'clear-pose', silhouette: 0.94, featureVisibility: 0.91, actionArc: 0.82,
        blur: 0.08, occlusion: 0.06, sharedGridId: 'pet-48', sharedPaletteId: 'pet-run-v1',
      },
      {
        id: 'occluded', silhouette: 0.7, featureVisibility: 0.5, actionArc: 0.88,
        blur: 0.1, occlusion: 0.75, sharedGridId: 'pet-48', sharedPaletteId: 'pet-run-v1',
      },
    ])

    assert.equal(result.selectedFrameId, 'clear-pose')
    assert.deepEqual(result.rankedFrameIds, ['clear-pose', 'blurred-arc', 'occluded'])
    assert.equal(result.sharedGridId, 'pet-48')
    assert.equal(result.sharedPaletteId, 'pet-run-v1')
  })

  it('converts the plan into bounded generation and craft parameters', () => {
    const plan = planPixelArtDirection({
      width: 32, height: 32, style: 'simple', imageType: 'general', subjectOccupancy: 0.45,
      semanticLabels: ['metal', 'glass'], beadDiameterMm: 5,
    })

    assert.ok(plan.generation.maxColorFactor > 0 && plan.generation.maxColorFactor <= 1)
    assert.ok(plan.generation.isolatedPixelPenalty >= 0)
    assert.ok(plan.generation.stripePenalty >= 0)
    assert.ok(plan.generation.aliasPenalty >= 0)
    assert.ok(plan.craft.estimatedBeads <= 32 * 32)
    assert.equal(plan.craft.boardWidthMm, 160)
    assert.ok(plan.craft.fragilityPenalty >= 0)
  })

  it('drives candidate value, palette, cleanup, and exported diagnostics', async () => {
    const algorithm = createPatternAlgorithm()
    const generate = (style: 'simple' | 'faithful') => algorithm.generate({
      image: multicolorImage(), palette: integrationPalette,
      options: {
        canvas: { mode: 'fixed' as const, size: { width: 32, height: 32 } },
        maxColors: 6, maxCandidates: 1, styles: [style],
        ...(style === 'simple' ? {
          artDirection: {
            mode: 'tile' as const,
            tileEdges: { top: 'grass', right: 'path', bottom: 'grass', left: 'path' },
          },
        } : {}),
        optimization: { refinementMode: 'quality' as const },
      },
    })
    const simpleResult = await generate('simple')
    const faithfulResult = await generate('faithful')
    const simple = simpleResult.recommended ?? simpleResult.bestEffort
    const faithful = faithfulResult.recommended ?? faithfulResult.bestEffort

    assert.ok(simple?.artDirection !== undefined)
    assert.ok(faithful?.artDirection !== undefined)
    assert.equal(simple.artDirection.profile.id, 'clear-v1')
    assert.equal(simple.artDirection.tile?.seamSignature, 'grass|path|grass|path')
    assert.equal(faithful.artDirection.profile.id, 'delicate-v1')
    assert.ok(simple.artDirection.generation.maxColorFactor
      < faithful.artDirection.generation.maxColorFactor)
    assert.ok(simple.pattern.palette.length <= Math.round(6 * simple.artDirection.generation.maxColorFactor))
    assert.ok(simple.gridRefinement?.diagnosticsAfter.smallComponents !== undefined)
    assert.ok(simple.artDirectionExecution?.tile?.seamEdits !== undefined)
    assert.equal(simple.metrics.tileSeamEdits, simple.artDirectionExecution?.tile?.seamEdits)
    assert.equal(simple.metrics.artDirectionBudgetViolations,
      simple.gridRefinement?.budgetViolationsAfter.total ?? 0)
  })

  it('changes the candidate when explicit focus compresses background detail', async () => {
    const scene = focusedScene()
    const palette: MaterialPalette = {
      id: 'focus-palette', name: 'Focus palette', colors: [
        integrationPalette.colors[1]!,
        integrationPalette.colors[4]!,
      ],
    }
    const generate = (artDirection: { focus: readonly [number, number]; depthRange: readonly [number, number] } | undefined) =>
      createPatternAlgorithm().generate({
        image: scene.image,
        palette,
        analysis: scene.analysis,
        options: {
          canvas: { mode: 'fixed', size: { width: 8, height: 8 } },
          maxColors: 2,
          maxCandidates: 1,
          styles: ['faithful'],
          ...(artDirection === undefined ? {} : { artDirection }),
        },
      })
    const baselineResult = await generate(undefined)
    const directedResult = await generate({ focus: [0.85, 0.5], depthRange: [0, 1] })
    const baseline = baselineResult.recommended ?? baselineResult.bestEffort
    const directed = directedResult.recommended ?? directedResult.bestEffort

    assert.ok(baseline !== undefined && directed !== undefined)
    assert.equal(baseline.metrics.artDirectionImportanceChanges, 0)
    assert.ok(directed.metrics.artDirectionImportanceChanges > 0)
    assert.ok(directed.metrics.artDirectionBackgroundCompressedCells > 0)
    assert.ok(Math.abs(directed.score.total - baseline.score.total) > 1e-9
      || directed.metrics.artDirectionImportanceChanges > baseline.metrics.artDirectionImportanceChanges)
  })

  it('keeps default generation free of execution-layer edits', async () => {
    const result = await createPatternAlgorithm().generate({
      image: multicolorImage(), palette: integrationPalette,
      options: {
        canvas: { mode: 'fixed', size: { width: 32, height: 32 } },
        maxColors: 6, maxCandidates: 1, styles: ['faithful'],
      },
    })
    const candidate = result.recommended ?? result.bestEffort

    assert.ok(candidate !== undefined)
    assert.equal(candidate.artDirectionExecution?.enabled, false)
    assert.equal(candidate.metrics.artDirectionImportanceChanges, 0)
    assert.equal(candidate.metrics.tileSeamEdits, 0)
  })
})
