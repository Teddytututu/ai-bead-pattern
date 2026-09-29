import { createPatternDocument, patternMaterialsCsv, patternSvg } from '../../../packages/pattern-core/dist/index.js'

export async function downloadPatternFile(pattern, format) {
  let blob
  if (format === 'png') {
    const svgUrl = URL.createObjectURL(new Blob([patternSvg(pattern)], { type: 'image/svg+xml' }))
    const bitmap = new Image()
    try {
      bitmap.src = svgUrl
      await bitmap.decode()
    } finally {
      URL.revokeObjectURL(svgUrl)
    }
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG 导出失败')
  } else if (format === 'csv') blob = new Blob([patternMaterialsCsv(pattern)], { type: 'text/csv;charset=utf-8' })
  else blob = new Blob([JSON.stringify(createPatternDocument(pattern), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url
  link.download = `${pattern.metadata.paletteId}-${pattern.width}x${pattern.height}-${pattern.metadata.style}.${format}`
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
