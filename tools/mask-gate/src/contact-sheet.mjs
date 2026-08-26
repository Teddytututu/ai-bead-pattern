import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import sharp from 'sharp'

import { validateMaskGateCandidatePool } from './dataset.mjs'

function positiveInteger(value, name) {
  if (Number.isInteger(value) === false || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function labelSvg(entry, width) {
  const title = escapeXml(entry.imageId)
  const metadata = escapeXml(`${entry.category} / ${entry.cohort}`)
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="36">
    <style>text { font-family: Arial, sans-serif; fill: #171717; }</style>
    <text x="0" y="12" font-size="11" font-weight="700">${title}</text>
    <text x="0" y="28" font-size="9">${metadata}</text>
  </svg>`)
}

export async function renderMaskGateContactSheet({
  entries,
  outputPath,
  columns = 6,
  thumbnailSize = 160,
}) {
  if (Array.isArray(entries) === false || entries.length === 0) {
    throw new RangeError('entries must contain at least one candidate')
  }
  positiveInteger(columns, 'columns')
  positiveInteger(thumbnailSize, 'thumbnailSize')
  const cellWidth = thumbnailSize + 16
  const cellHeight = thumbnailSize + 52
  const rows = Math.ceil(entries.length / columns)
  const composites = []

  for (const [index, entry] of entries.entries()) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = column * cellWidth + 8
    const top = row * cellHeight + 8
    const thumbnail = await sharp(entry.path)
      .rotate()
      .resize({
        width: thumbnailSize,
        height: thumbnailSize,
        fit: 'contain',
        background: '#ffffff',
      })
      .png()
      .toBuffer()
    composites.push({ input: thumbnail, left, top })
    composites.push({ input: labelSvg(entry, thumbnailSize), left, top: top + thumbnailSize + 4 })
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: '#f5f5f5',
    },
  }).composite(composites).png().toFile(outputPath)
  return { width: columns * cellWidth, height: rows * cellHeight, rows, columns }
}

export async function renderMaskGateContactSheetFromPool({
  poolPath,
  imageDirectory,
  outputPath,
  columns = 6,
  thumbnailSize = 160,
}) {
  const pool = validateMaskGateCandidatePool(JSON.parse(await readFile(poolPath, 'utf8')))
  const poolDirectory = dirname(resolve(poolPath))
  const entries = pool.candidates.map((candidate) => ({
    imageId: candidate.imageId,
    category: candidate.category,
    cohort: candidate.cohort,
    path: imageDirectory === undefined
      ? resolve(poolDirectory, candidate.imagePath)
      : join(imageDirectory, basename(candidate.imagePath)),
  }))
  return renderMaskGateContactSheet({ entries, outputPath, columns, thumbnailSize })
}
