import { mkdir, writeFile } from 'node:fs/promises'
import { createPatternAlgorithm, featureTemplateLibrary } from '../packages/pattern-core/dist/index.js'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const sharp = createRequire(new URL('../services/ai-gateway/package.json', import.meta.url))('sharp')

const output = new URL('../output/contours-features/', import.meta.url)
await mkdir(output, { recursive: true })
const roles = { 'eye-dark': '#282329', 'eye-iris': '#847141', 'eye-white': '#deddd3', 'eye-highlight': '#ffffff', 'mouth-dark': '#482f38', 'mouth-inner': '#d4838d', 'nose-base': '#a86f79', 'ear-tip': '#795260', 'identity-dark': '#4d4844', 'endpoint-dark': '#4d4844' }
const rect = (x, y, width, height, fill, stroke = '#ddd') => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>`
const text = (x, y, value, size = 13) => `<text x="${x}" y="${y}" font-size="${size}" fill="#262a30">${value}</text>`
const svg = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Segoe UI, sans-serif">${rect(0, 0, width, height, '#f6f4ef')}${body}</svg>`
let atlas = text(22, 28, 'Original feature stencils v2 — occupied vs. reserved cells', 20)
featureTemplateLibrary.forEach((template, index) => {
  const x = 20 + index % 5 * 206, y = 60 + Math.floor(index / 5) * 172
  atlas += text(x, y, template.id) + text(x, y + 19, `${template.width} x ${template.height} / ${template.cells.length} beads`, 11)
  for (let row = 0; row < template.height; row++) for (let col = 0; col < template.width; col++) {
    const cell = template.cells.find(cell => cell.x === col && cell.y === row)
    atlas += rect(x + col * 20, y + 32 + row * 20, 20, 20, cell ? roles[cell.role] : '#ead9bf')
    if (!cell) atlas += text(x + col * 20 + 5, y + 46 + row * 20, '·', 14)
  }
})
await writeFile(new URL('template-atlas.svg', output), svg(1050, 80 + Math.ceil(featureTemplateLibrary.length / 5) * 172, atlas))
await sharp(Buffer.from(svg(1050, 80 + Math.ceil(featureTemplateLibrary.length / 5) * 172, atlas))).png().toFile(fileURLToPath(new URL('template-atlas.png', output)))

const size = 32, data = new Uint8ClampedArray(size * size * 4), mask = new Float32Array(size * size)
const left = new Float32Array(size * size), right = new Float32Array(size * size)
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const cell = y * size + x, inside = Math.hypot((x - 15.5) / 13, (y - 15.5) / 14) <= 1
  mask[cell] = Number(inside); (x < 16 ? left : right)[cell] = Number(inside)
  data.set(inside ? [160, 160, 160, 255] : [245, 245, 242, 255], cell * 4)
}
const colors = [0, 80, 104, 128, 160, 190, 220, 245, 255].map(value => ({ id: `gray-${value}`, name: `Gray ${value}`, hex: `#${value.toString(16).padStart(2, '0').repeat(3)}`, rgb: [value, value, value] }))
const cases = [
  ['Contours off', { external: false, internal: false }, []], ['External only', { external: true, internal: false }, []],
  ['Internal only', { external: false, internal: true }, []], ['Both contours', { external: true, internal: true }, []],
  ['Sloping eyes', { external: false, internal: false }, [{ id: 'near', kind: 'eye', x: 8, y: 10, templateId: 'eye-open-2x3' }, { id: 'far', kind: 'eye', x: 23, y: 15, templateId: 'eye-open-2x3' }]],
  ['Perspective sizes', { external: false, internal: false }, [{ id: 'near', kind: 'eye', x: 8, y: 10, templateId: 'eye-open-3x3' }, { id: 'far', kind: 'eye', x: 23, y: 15, templateId: 'eye-e1' }]],
  ['90 degree roll', { external: false, internal: false }, [{ id: 'near', kind: 'eye', x: 16, y: 8, templateId: 'eye-open-3x2', shape: { widthPx: 3, heightPx: 2, angleDegrees: 90 } }, { id: 'far', kind: 'eye', x: 16, y: 23, templateId: 'eye-open-3x2', shape: { widthPx: 3, heightPx: 2, angleDegrees: 90 } }]],
  ['One eye hidden', { external: false, internal: false }, [{ id: 'near', kind: 'eye', x: 10, y: 12, templateId: 'eye-open-3x3' }, { id: 'far', kind: 'eye', x: 23, y: 15, hidden: true }]],
]
const algorithm = createPatternAlgorithm(), results = []
let panels = text(20, 28, 'Synthetic regression examples — source pose is preserved', 20)
for (const [index, [name, contours, featureOverrides]] of cases.entries()) {
  const result = await algorithm.generate({ image: { width: size, height: size, data }, palette: { id: 'diagnostic-gray', name: 'Diagnostic gray', colors },
    analysis: { subjectMask: { width: size, height: size, values: mask }, semanticRegions: [
      { id: 'left', label: 'face-skin', confidence: 1, mask: { width: size, height: size, values: left } },
      { id: 'right', label: 'hair', confidence: 1, mask: { width: size, height: size, values: right } },
    ] }, options: { canvas: { mode: 'fixed', size: { width: size, height: size } }, styles: ['faithful'], maxColors: colors.length, maxCandidates: 1,
      structure: { occupancyMode: 'full-frame', valueMode: 'preserve', contours }, featureOverrides } })
  const candidate = result.recommended ?? result.bestEffort
  if (!candidate) throw new Error(`Missing diagnostic candidate: ${name}`)
  results.push({ name, status: result.status, contour: candidate.contourPlan, placements: candidate.featurePlacements })
  const x = 20 + index % 4 * 252, y = 68 + Math.floor(index / 4) * 280
  panels += text(x, y - 12, name, 15)
  const palette = new Map(candidate.pattern.palette.map(color => [color.id, color.hex]))
  for (const cell of candidate.pattern.cells) panels += rect(x + cell.x * 7, y + cell.y * 7, 7, 7, palette.get(cell.colorId))
  panels += text(x, y + 242, `${candidate.contourPlan.diagnostics.selectedCells} contour cells / ${candidate.featurePlacements?.length ?? 0} features`, 11)
}
const comparison = svg(1020, 620, panels)
await writeFile(new URL('pose-contours.svg', output), comparison)
await writeFile(new URL('diagnostics.json', output), JSON.stringify({ version: algorithm.version, results }, null, 2))
await sharp(Buffer.from(comparison)).png().toFile(fileURLToPath(new URL('pose-contours.png', output)))
process.stdout.write('Saved template atlas, pose/contour comparison and diagnostics to output/contours-features/\n')
