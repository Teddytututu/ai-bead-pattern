import sharp from 'sharp'

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export async function renderPattern(candidate, outputPath, options = {}) {
  const pattern = candidate.pattern
  const cellSize = options.cellSize ?? 10
  const width = pattern.width * cellSize
  const height = pattern.height * cellSize
  const rgba = Buffer.alloc(width * height * 4, 255)
  const colorById = new Map(pattern.palette.map((color) => [color.id, color.rgb]))
  const occupied = new Set(pattern.cells.map((cell) => `${cell.x},${cell.y}`))
  for (const cell of pattern.cells) {
    const color = colorById.get(cell.colorId)
    if (color === undefined) continue
    for (let dy = 0; dy < cellSize; dy += 1) for (let dx = 0; dx < cellSize; dx += 1) {
      const index = ((cell.y * cellSize + dy) * width + cell.x * cellSize + dx) * 4
      rgba[index] = color[0]
      rgba[index + 1] = color[1]
      rgba[index + 2] = color[2]
    }
  }
  if (options.outline === true) {
    const outline = [22, 27, 25]
    const thickness = Math.max(1, Math.round(cellSize * 0.16))
    const fill = (x0, y0, x1, y1) => {
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
          const index = (y * width + x) * 4
          rgba[index] = outline[0]
          rgba[index + 1] = outline[1]
          rgba[index + 2] = outline[2]
        }
      }
    }
    for (const cell of pattern.cells) {
      const x = cell.x * cellSize
      const y = cell.y * cellSize
      if (occupied.has(`${cell.x},${cell.y - 1}`) === false) fill(x, y, x + cellSize, y + thickness)
      if (occupied.has(`${cell.x + 1},${cell.y}`) === false) fill(x + cellSize - thickness, y, x + cellSize, y + cellSize)
      if (occupied.has(`${cell.x},${cell.y + 1}`) === false) fill(x, y + cellSize - thickness, x + cellSize, y + cellSize)
      if (occupied.has(`${cell.x - 1},${cell.y}`) === false) fill(x, y, x + thickness, y + cellSize)
    }
  }
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(outputPath)
}

export async function renderSampleSheet({ sourcePath, imageId, candidates, outputPath }) {
  const panelWidth = 240
  const panelHeight = 280
  const labels = ['Source', ...candidates.map((candidate) => candidate.id)]
  const sources = [sourcePath, ...candidates.map((candidate) => candidate.imagePath)]
  const composites = []
  for (let index = 0; index < sources.length; index += 1) {
    const image = await sharp(sources[index]).resize(220, 220, {
      fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 }, kernel: 'nearest',
    }).png().toBuffer()
    composites.push({ input: image, left: index * panelWidth + 10, top: 44 })
    const label = Buffer.from(`<svg width="${panelWidth}" height="40"><rect width="100%" height="100%" fill="#ffffff"/><text x="12" y="27" font-family="Arial" font-size="20" font-weight="700" fill="#17211d">${escapeXml(labels[index])}</text></svg>`)
    composites.push({ input: label, left: index * panelWidth, top: 0 })
  }
  const header = Buffer.from(`<svg width="${panelWidth * sources.length}" height="24"><rect width="100%" height="100%" fill="#17211d"/><text x="10" y="18" font-family="Arial" font-size="15" fill="#ffffff">${escapeXml(imageId)}</text></svg>`)
  composites.push({ input: header, left: 0, top: panelHeight - 24 })
  await sharp({
    create: { width: panelWidth * sources.length, height: panelHeight, channels: 4, background: '#ffffff' },
  }).composite(composites).png().toFile(outputPath)
}

export async function renderBatchSheet(sampleSheetPaths, outputPath) {
  if (sampleSheetPaths.length === 0) throw new RangeError('Batch sheet requires samples')
  const metadata = await sharp(sampleSheetPaths[0]).metadata()
  const width = metadata.width
  const rowHeight = metadata.height
  const composites = await Promise.all(sampleSheetPaths.map(async (path, index) => ({
    input: await sharp(path).png().toBuffer(), left: 0, top: index * rowHeight,
  })))
  await sharp({
    create: { width, height: rowHeight * sampleSheetPaths.length, channels: 4, background: '#ffffff' },
  }).composite(composites).png().toFile(outputPath)
}
