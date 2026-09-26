function alphaAnalysis(image) {
  const values = new Float32Array(image.width * image.height)
  let hasTransparency = false
  for (let index = 0; index < values.length; index += 1) {
    const alpha = (image.data[index * 4 + 3] ?? 255) / 255
    values[index] = alpha
    hasTransparency ||= alpha < 0.98
  }
  const subjectMask = { width: image.width, height: image.height, values }
  return hasTransparency ? {
    subjectMask,
    subjectMaskEvidence: {
      mask: subjectMask,
      confidence: 1,
      source: 'alpha',
      revision: 'demo:alpha-channel:alpha-v1',
      provenance: [{ origin: 'source', provider: 'alpha-channel', version: 'alpha-v1' }],
    },
    confidence: 1,
    source: 'alpha',
    modelVersions: { 'demo-subject-mask': 'alpha-v1' },
  } : undefined
}

export function inferSubjectAnalysis(image) {
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Image data must contain complete RGBA pixels')
  }
  return alphaAnalysis(image) ?? { confidence: 0, source: 'unavailable' }
}
