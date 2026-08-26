function csv(value) {
  const source = value === undefined || value === null ? '' : String(value)
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source
}

function rows(header, values) {
  return `${[header, ...values.map((row) => row.map(csv).join(','))].join('\n')}\n`
}

export function renderSampleBreakdownCsv(summary) {
  return rows('imageId,size,featureCount,top2AcceptedCount,fullyVisibleCount,collisionCount', summary.results.map((result) => [
    result.imageId,
    result.size,
    result.features.length,
    result.features.filter((feature) => feature.top2Accepted).length,
    result.features.filter((feature) => feature.fullyVisible).length,
    result.collisions.length,
  ]))
}

export function renderFeatureBreakdownCsv(summary) {
  return rows('imageId,size,featureId,kind,selectedTemplateId,top2Accepted,fullyVisible,visibilityRate,occupiedCells',
    summary.results.flatMap((result) => result.features.map((feature) => [
      result.imageId,
      result.size,
      feature.featureId,
      feature.kind,
      feature.selectedTemplateId,
      feature.top2Accepted,
      feature.fullyVisible,
      feature.visibilityRate,
      feature.occupiedCells.join('|'),
    ])))
}

export function renderCollisionBreakdownCsv(summary) {
  return rows('imageId,size,firstFeatureId,secondFeatureId,overlapCells',
    summary.results.flatMap((result) => result.collisions.map((collision) => [
      result.imageId,
      result.size,
      collision.firstFeatureId,
      collision.secondFeatureId,
      collision.overlapCells.join('|'),
    ])))
}

export function renderSizeBreakdownCsv(summary) {
  const sizes = [32, 48, 64]
  return rows('size,records,eyeTop2Acceptance,mouthTop2Acceptance,hardVisibility,collisions', sizes.map((size) => {
    const results = summary.results.filter((result) => result.size === size)
    const features = results.flatMap((result) => result.features)
    const eyes = features.filter((feature) => feature.kind === 'eye')
    const mouths = features.filter((feature) => feature.kind === 'mouth')
    const hard = features.filter((feature) => feature.hard)
    const rate = (values, predicate) => values.length === 0 ? '' : values.filter(predicate).length / values.length
    return [
      size,
      results.length,
      rate(eyes, (feature) => feature.top2Accepted),
      rate(mouths, (feature) => feature.top2Accepted),
      rate(hard, (feature) => feature.fullyVisible),
      results.reduce((sum, result) => sum + result.collisions.length, 0),
    ]
  }))
}
