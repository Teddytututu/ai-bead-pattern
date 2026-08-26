const landmarkThresholds = Object.freeze({
  'left-eye-center': 1,
  'right-eye-center': 1,
  'mouth-center': 1.5,
})

function predictedCells(mask, gridSize, threshold = 0.5) {
  const cells = new Set()
  for (let gridY = 0; gridY < gridSize; gridY += 1) {
    const startY = Math.min(mask.height - 1, Math.floor(gridY * mask.height / gridSize))
    const endY = Math.max(startY + 1, Math.ceil((gridY + 1) * mask.height / gridSize))
    for (let gridX = 0; gridX < gridSize; gridX += 1) {
      const startX = Math.min(mask.width - 1, Math.floor(gridX * mask.width / gridSize))
      const endX = Math.max(startX + 1, Math.ceil((gridX + 1) * mask.width / gridSize))
      let total = 0
      let count = 0
      for (let sourceY = startY; sourceY < Math.min(mask.height, endY); sourceY += 1) {
        for (let sourceX = startX; sourceX < Math.min(mask.width, endX); sourceX += 1) {
          total += mask.values[sourceY * mask.width + sourceX] ?? 0
          count += 1
        }
      }
      if (count > 0 && total / count >= threshold) {
        cells.add(gridY * gridSize + gridX)
      }
    }
  }
  return cells
}

function overlap(referenceCells, prediction) {
  const reference = new Set(referenceCells)
  let intersection = 0
  for (const cell of prediction) if (reference.has(cell)) intersection += 1
  return {
    intersection,
    containment: reference.size === 0 ? 0 : intersection / reference.size,
    dice: reference.size + prediction.size === 0
      ? 1
      : (2 * intersection) / (reference.size + prediction.size),
  }
}

export function evaluateVisionGateSample(sample, prediction, gridSize = 48) {
  const predictionsById = new Map(prediction.landmarks.map((entry) => [entry.id, entry]))
  const landmarks = Object.fromEntries(Object.entries(landmarkThresholds).map(([id, threshold]) => {
    const expected = sample.annotations.landmarks[id]
    const actual = predictionsById.get(id)
    const errorCells = actual === undefined
      ? Number.POSITIVE_INFINITY
      : Math.hypot((actual.x - expected.x) * gridSize, (actual.y - expected.y) * gridSize)
    const withinThreshold = errorCells <= threshold
    return [id, {
      id,
      kind: id.includes('eye') ? 'eye' : 'mouth',
      thresholdCells: threshold,
      errorCells,
      confidence: actual?.confidence ?? 0,
      withinThreshold,
      highConfidenceMismatch: (actual?.confidence ?? 0) >= 0.9 && withinThreshold === false,
    }]
  }))
  const regions = Object.fromEntries(['face-skin', 'hair', 'clothes'].map((id) => {
    const mask = prediction.regions[id]
    const metrics = mask === undefined
      ? { intersection: 0, containment: 0, dice: 0 }
      : overlap(sample.annotations.regions[id].cells, predictedCells(mask, gridSize))
    return [id, { id, ...metrics }]
  }))
  return {
    imageId: sample.imageId,
    challengeTags: sample.challengeTags,
    selectionStatus: prediction.selectionStatus,
    modelVersions: prediction.modelVersions,
    landmarks,
    regions,
  }
}
