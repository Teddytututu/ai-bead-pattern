import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import {
  createPatternAlgorithm,
  inferPetAnalysis,
  type BinaryMask,
  type MaterialPalette,
  type PixelImage,
} from '@ai-bead-pattern/pattern-core'

async function fixture(): Promise<{ image: PixelImage, mask: BinaryMask, palette: MaterialPalette }> {
  const imagePath = new URL('../../../../apps/demo/assets/sample-cat.png', import.meta.url)
  const maskPath = new URL('../../../../apps/demo/assets/sample-cat-mask.png', import.meta.url)
  const palettePath = new URL('../../../../assets/palettes/generic-24.json', import.meta.url)
  const image = await sharp(fileURLToPath(imagePath)).resize(512, 512).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const mask = await sharp(fileURLToPath(maskPath)).resize(512, 512).greyscale().raw().toBuffer({ resolveWithObject: true })
  return {
    image: { width: 512, height: 512, data: new Uint8ClampedArray(image.data) },
    mask: { width: 512, height: 512, values: Float32Array.from(mask.data, (value) => value / 255) },
    palette: JSON.parse(await readFile(palettePath, 'utf8')) as MaterialPalette,
  }
}

describe('pet pipeline regression', () => {
  it('keeps quality refinement from increasing visible pixel-cluster defects', async () => {
    const { image, mask, palette } = await fixture()
    const pet = inferPetAnalysis(image, mask)
    assert.ok(pet)
    const faceValues = new Float32Array(mask.values.length)
    for (let y = pet.suggestedCrop.y; y < pet.suggestedCrop.y + pet.suggestedCrop.height; y += 1) {
      for (let x = pet.suggestedCrop.x; x < pet.suggestedCrop.x + pet.suggestedCrop.width; x += 1) {
        faceValues[y * mask.width + x] = 1
      }
    }
    const result = await createPatternAlgorithm().generate({
      image,
      palette,
      analysis: {
        imageType: 'pet',
        confidence: pet.confidence,
        subjectMask: mask,
        subjectMaskEvidence: {
          mask,
          confidence: 0.96,
          source: 'ai',
          revision: 'test:sample-cat:birefnet-v1',
        },
        landmarks: pet.landmarks,
        suggestedCrop: pet.suggestedCrop,
        suggestedCropSource: 'automatic',
        suggestedCropConfidence: pet.suggestedCropConfidence,
        semanticRegions: [{
          id: 'subject',
          label: 'subject',
          mask,
          confidence: 0.96,
          importance: 0.9,
        }, {
          id: 'pet-face',
          label: 'pet face',
          mask: { width: mask.width, height: mask.height, values: faceValues },
          confidence: pet.confidence,
          importance: 1,
        }],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 64, height: 64 } },
        maxColors: 20,
        maxCandidates: 3,
        styles: ['high-contrast'],
        baseline: 'mvp',
        imageType: 'pet',
        backgroundRgb: [245, 245, 242],
        structure: {
          importanceStrength: 3.5,
          edgeStrength: 1.1,
          valueLevels: 3,
          occupancyMode: 'subject-shape',
          shapeRefinementIterations: 2,
        },
        optimization: {
          minRegionSize: 2,
          isolatedPixelPenalty: 1,
          stripePenalty: 1,
          aliasPenalty: 1,
          paletteCoherence: 1.15,
          localSearchIterations: 2,
          edgeProtection: 0.8,
          refinementMode: 'quality',
        },
      },
    })
    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate?.gridRefinement)
    const cellsByIndex = new Map(candidate.pattern.cells.map((cell) => [
      cell.y * candidate.pattern.width + cell.x,
      cell.colorId,
    ]))
    assert.ok(result.recommended, JSON.stringify({
      status: result.status,
      reasons: candidate.rejectionReasons,
      score: candidate.score,
      palette: candidate.palettePlan?.selectedColorIds,
      placements: candidate.featurePlacements?.map((placement) => ({
        id: placement.featureId,
        roles: placement.roles.map((role) => [role.role, cellsByIndex.get(role.cell)]),
      })),
    }))
    assert.ok(candidate.score.identity >= 0.5)
    assert.ok((candidate.score.identityAppearance ?? 0) >= 0.45)
    const defectCost = (diagnostics: typeof candidate.gridRefinement.diagnosticsBefore) =>
      diagnostics.fragmentedArcSegments
        + diagnostics.smallComponents * 4
        + diagnostics.singleCellBands * 2

    assert.ok(
      defectCost(candidate.gridRefinement.diagnosticsAfter)
      < defectCost(candidate.gridRefinement.diagnosticsBefore),
    )
  })
})
