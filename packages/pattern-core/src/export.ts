import type { BeadPattern } from './types.js'

/** Portable, row-major document. -1 denotes empty board space. */
export function createPatternDocument(pattern: BeadPattern) {
  const { width, height } = pattern
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 9_216) {
    throw new RangeError('Invalid export dimensions')
  }
  const colors = pattern.palette.map(color => ({ ...color, rgb: [...color.rgb] }))
  const indices = new Map(colors.map((color, index) => [color.id, index]))
  if (indices.size !== colors.length) throw new RangeError('Duplicate export palette id')
  const grid: number[] = Array(width * height).fill(-1)
  const counts = new Map<string, number>()
  for (const cell of pattern.cells) {
    const index = indices.get(cell.colorId)
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0
      || cell.x >= width || cell.y >= height || index === undefined) throw new RangeError('Invalid export cell')
    const offset = cell.y * width + cell.x
    if (grid[offset] !== -1) throw new RangeError('Duplicate export cell')
    grid[offset] = index
    counts.set(cell.colorId, (counts.get(cell.colorId) ?? 0) + 1)
  }
  const materials = colors.filter(color => counts.has(color.id)).map(color => ({
    colorId: color.id, code: color.code ?? color.id, hex: color.hex, count: counts.get(color.id)!,
  })).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
  return {
    schema: 'bead-pattern-document-v1' as const, width, height,
    paletteId: pattern.metadata.paletteId ?? 'custom', paletteVersion: pattern.metadata.paletteVersion ?? 'unknown',
    brand: pattern.metadata.paletteBrand ?? '', colors, grid, materials,
    totalBeads: pattern.cells.length, metadata: { ...pattern.metadata },
  }
}
export type PatternDocument = ReturnType<typeof createPatternDocument>

export function patternMaterialsCsv(pattern: BeadPattern): string {
  const doc = createPatternDocument(pattern)
  const quote = (value: string | number): string => {
    let text = String(value)
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + [ ['brand', 'paletteId', 'paletteVersion', 'code', 'hex', 'count'],
    ...doc.materials.map(m => [doc.brand, doc.paletteId, doc.paletteVersion, m.code, m.hex, m.count]),
  ].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n'
}

export function patternSvg(pattern: BeadPattern): string {
  const doc = createPatternDocument(pattern), left = 42, top = 76
  // Perler uses full purchase SKUs such as 80-19001; reserve room for every character.
  const cell = Math.max(22, ...doc.colors.map(color => (color.code ?? color.id).length * 5 + 6))
  const width = Math.max(680, doc.width * cell + left + 24)
  const columns = Math.max(1, Math.floor((width - 48) / 150))
  const legendY = top + doc.height * cell + 42
  const height = legendY + Math.ceil(doc.materials.length / columns) * 28 + 46
  const escape = (v: unknown) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const text = (x: number, y: number, value: unknown, size = 12, fill = '#222', anchor = 'start') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escape(value)}</text>`
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, sans-serif"><rect width="100%" height="100%" fill="white"/>`,
    text(24, 26, `${doc.brand || doc.paletteId} | ${doc.width} x ${doc.height} | ${doc.totalBeads} beads`, 18),
    text(24, 46, doc.paletteVersion, 10)]
  for (let x = 0; x < doc.width; x++) parts.push(text(left + x * cell + cell / 2, top - 8, x + 1, 9, '#333', 'middle'))
  for (let y = 0; y < doc.height; y++) parts.push(text(left - 8, top + y * cell + cell / 2 + 3, y + 1, 9, '#333', 'end'))
  doc.grid.forEach((index, i) => {
    const color = doc.colors[index], x = left + i % doc.width * cell, y = top + Math.floor(i / doc.width) * cell
    const fill = color?.hex ?? '#ffffff'
    if (!/^#[0-9a-f]{6}$/i.test(fill)) throw new RangeError('Invalid export HEX')
    parts.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fill}" stroke="#aaa" stroke-width="0.5"/>`)
    if (color) {
      const [r = 0, g = 0, b = 0] = color.rgb
      parts.push(text(x + cell / 2, y + cell / 2 + 3, color.code ?? color.id, 7, r * .299 + g * .587 + b * .114 > 145 ? '#111' : '#fff', 'middle'))
    }
  })
  parts.push(text(24, legendY - 12, 'Color code / bead count', 13))
  doc.materials.forEach((m, i) => {
    const x = 24 + i % columns * 150, y = legendY + Math.floor(i / columns) * 28
    parts.push(`<rect x="${x}" y="${y}" width="16" height="16" fill="${m.hex}" stroke="#888"/>`, text(x + 24, y + 13, `${m.code} / ${m.count}`, 12))
  })
  parts.push(text(24, height - 14, 'Screen reference colors. Empty cells contain no beads.', 10), '</svg>')
  return parts.join('')
}
