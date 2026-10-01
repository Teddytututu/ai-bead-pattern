// Local reproducible comparison. Reuses saved network output; never uploads the image.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createPatternAlgorithm } from '../../packages/pattern-core/dist/index.js'
import { hydrateImageAnalysis } from '../../services/ai-gateway/dist/index.js'
import { resizePixels } from '../../packages/pattern-core/dist/image.js'
import { deltaE2000, rgbToLab } from '../../packages/pattern-core/dist/color.js'
import sharp from 'sharp'
const phase = process.argv[2] ?? 'after'
if (!['before', 'after'].includes(phase)) throw new Error('Expected before or after')
const file = process.argv[3] ?? 'tests/fixtures/images/kitten.jfif'
const wire = JSON.parse(await readFile(process.argv[4] ?? 'output/diagnostics/neural-masks/http.json', 'utf8'))
const palette = JSON.parse(await readFile('assets/palettes/mard-291.json', 'utf8'))
const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const image = { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) }
const analysis = hydrateImageAnalysis(wire.analysis)
if (image.width !== analysis.subjectMask.width || image.height !== analysis.subjectMask.height) throw new Error('Image and saved mask dimensions differ')
const result = await createPatternAlgorithm().generate({ image, analysis, palette,
  options: { canvas: { mode: 'fixed', size: { width: 64, height: 64 } }, maxColors: 20, maxCandidates: 1,
    styles: ['faithful'], ...(process.env.FILL_RESIZE_METHOD ? { resizeMethod: process.env.FILL_RESIZE_METHOD } : {}),
    structure: { valueMode: 'preserve', occupancyMode: 'subject-shape' }, optimization: { refinementMode: 'quality' } } })
const candidate = result.recommended ?? result.bestEffort
if (!candidate) throw new Error('No candidate')
await mkdir('output/diagnostics/fill-policy', { recursive: true })
await writeFile(`output/diagnostics/fill-policy/${phase}.json`, JSON.stringify({ status: result.status, candidate }))
const colors = new Map(candidate.pattern.palette.map(color => [color.id, color.hex]))
const rectangles = candidate.pattern.cells.map(c => `<rect x="${c.x * 8}" y="${c.y * 8}" width="8" height="8" fill="${colors.get(c.colorId)}"/>`).join('')
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#e9ece7"/>${rectangles}</svg>`)).png().toFile(`output/diagnostics/fill-policy/${phase}.png`)
console.log(JSON.stringify({ phase, status: result.status, outlineColors: [...new Set(Object.values(candidate.contourPlan.colorByCell))],
  cells: candidate.pattern.cells.length, black: candidate.pattern.cells.filter(c => c.colorId === 'H7').length,
  shapeIoU: candidate.metrics.subjectCoverageIoU, boundaryIoU: candidate.metrics.silhouetteBoundaryIoU,
  paletteChanges: candidate.metrics.paletteOptimizationChanges, refinementChanges: candidate.metrics.gridRefinementChanges,
  restored: candidate.metrics.fillFidelityRestoredCells,
  sourceBoundaryAgreement: candidate.metrics.sourceBoundaryAgreement, sourceDeltaE: candidate.metrics.sourceMeanColorDistance }))
if (phase === 'after') {
  const previous = JSON.parse(await readFile('output/diagnostics/fill-policy/before.json', 'utf8')).candidate
  const excluded = new Set([previous, candidate].flatMap(c => [...c.contourPlan.externalCells, ...c.contourPlan.internalCells]))
  const summarize = c => {
    const labs = new Map(c.pattern.palette.map(color => [color.id, rgbToLab(color.rgb)]))
    const grid = new Map(c.pattern.cells.map(cell => [cell.y * 64 + cell.x, labs.get(cell.colorId)]))
    const source = resizePixels(image, c.canvasPlan.crop, 64, 64, 'area').pixels.map(rgbToLab)
    let error = 0, cells = 0, sourceEdges = 0, retainedEdges = 0
    for (const [cell, lab] of grid) {
      if (excluded.has(cell)) continue
      error += deltaE2000(source[cell], lab); cells++
      for (const next of [cell % 64 < 63 ? cell + 1 : -1, cell + 64]) {
        if (!grid.has(next) || excluded.has(next)) continue
        if (deltaE2000(source[cell], source[next]) >= 8) {
          sourceEdges++
          if (deltaE2000(lab, grid.get(next)) >= 6) retainedEdges++
        }
      }
    }
    return { bodyCells: cells, bodyMeanDeltaE00: error / cells, sourceEdges, retainedEdges,
      bodyEdgeRetention: retainedEdges / Math.max(1, sourceEdges),
      outlineColors: [...new Set(Object.values(c.contourPlan.colorByCell))],
      blackCells: c.pattern.cells.filter(cell => cell.colorId === 'H7').length,
      subjectIoU: c.metrics.subjectCoverageIoU, boundaryIoU: c.metrics.silhouetteBoundaryIoU }
  }
  const summary = { before: summarize(previous), after: summarize(candidate),
    beforeVersion: previous.pattern.metadata.algorithmVersion, afterVersion: candidate.pattern.metadata.algorithmVersion }
  await writeFile('output/diagnostics/fill-policy/comparison.json', JSON.stringify(summary, null, 2))
  const panel = (c, x, title) => {
    const colors = new Map(c.pattern.palette.map(color => [color.id, color.hex]))
    return `<g transform="translate(${x},0)"><text x="16" y="25" font-family="sans-serif" font-size="18">${title}</text><g transform="translate(0,40)">${c.pattern.cells.map(cell => `<rect x="${cell.x * 8}" y="${cell.y * 8}" width="8" height="8" fill="${colors.get(cell.colorId)}"/>`).join('')}</g></g>`
  }
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="552"><rect width="1040" height="552" fill="#e9ece7"/>${panel(previous, 0, 'Before')}${panel(candidate, 528, `After: ${summary.after.outlineColors.join(', ')} outline, source fill`)}</svg>`)).png().toFile('output/diagnostics/fill-policy/comparison.png')
  console.log(JSON.stringify(summary))
}
