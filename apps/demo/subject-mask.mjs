function colorDistance(data, pixelIndex, reference) {
  const offset = pixelIndex * 4
  const red = (data[offset] ?? 0) - reference[0]
  const green = (data[offset + 1] ?? 0) - reference[1]
  const blue = (data[offset + 2] ?? 0) - reference[2]
  return Math.sqrt(red * red * 0.3 + green * green * 0.59 + blue * blue * 0.11)
}

function alphaAnalysis(image) {
  const values = new Float32Array(image.width * image.height)
  let hasTransparency = false
  for (let index = 0; index < values.length; index += 1) {
    const alpha = (image.data[index * 4 + 3] ?? 255) / 255
    values[index] = alpha
    hasTransparency ||= alpha < 0.98
  }
  return hasTransparency ? {
    subjectMask: { width: image.width, height: image.height, values },
    confidence: 1,
    source: 'alpha',
    modelVersions: { 'demo-subject-mask': 'alpha-v1' },
  } : undefined
}

function borderIndices(width, height) {
  const indices = []
  for (let x = 0; x < width; x += 1) {
    indices.push(x)
    if (height > 1) indices.push((height - 1) * width + x)
  }
  for (let y = 1; y + 1 < height; y += 1) {
    indices.push(y * width)
    if (width > 1) indices.push(y * width + width - 1)
  }
  return indices
}

function borderFloodAnalysis(image) {
  const { width, height, data } = image
  const corners = [0, width - 1, (height - 1) * width, width * height - 1]
  const reference = [0, 1, 2].map((channel) =>
    corners.reduce((sum, index) => sum + (data[index * 4 + channel] ?? 0), 0) / corners.length)
  const threshold = 30
  const background = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let tail = 0
  const border = borderIndices(width, height)
  for (const index of border) {
    if (background[index] === 0 && colorDistance(data, index, reference) <= threshold) {
      background[index] = 1
      queue[tail++] = index
    }
  }
  let head = 0
  while (head < tail) {
    const index = queue[head++]
    const x = index % width
    const y = Math.floor(index / width)
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ]
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && background[neighbor] === 0
        && colorDistance(data, neighbor, reference) <= threshold) {
        background[neighbor] = 1
        queue[tail++] = neighbor
      }
    }
  }
  const values = Float32Array.from(background, (value) => value === 1 ? 0 : 1)
  const borderAgreement = border.length === 0
    ? 0
    : border.reduce((sum, index) => sum + background[index], 0) / border.length
  const foregroundRatio = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const usableRatio = foregroundRatio > 0.01 && foregroundRatio < 0.95 ? 1 : 0.35
  return {
    subjectMask: { width, height, values },
    confidence: Math.min(0.92, borderAgreement * usableRatio),
    source: 'border-flood',
    modelVersions: { 'demo-subject-mask': 'border-flood-v1' },
  }
}

export function inferSubjectAnalysis(image) {
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Image data must contain complete RGBA pixels')
  }
  return alphaAnalysis(image) ?? borderFloodAnalysis(image)
}
