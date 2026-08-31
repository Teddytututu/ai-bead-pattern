export const analysisDebugLayers = Object.freeze([
  { id: 'original', label: '原图' },
  { id: 'ai-subject', label: 'AI 主体' },
  { id: 'corrected-subject', label: '修正主体' },
  { id: 'face', label: '脸部' },
  { id: 'hair', label: '头发' },
  { id: 'skin', label: '皮肤' },
  { id: 'clothes', label: '衣服' },
  { id: 'edges', label: '边缘' },
  { id: 'depth', label: '深度' },
  { id: 'embedding', label: '嵌入' },
  { id: 'landmarks', label: '关键点' },
  { id: 'features', label: '五官落格' },
])

const colors = Object.freeze({
  'ai-subject': [40, 125, 115],
  'corrected-subject': [36, 112, 185],
  face: [227, 184, 63],
  hair: [174, 71, 63],
  skin: [219, 126, 92],
  clothes: [83, 105, 151],
  edges: [214, 91, 65],
  depth: [74, 118, 167],
})

const featureColors = Object.freeze({
  'eye-dark': '#176f9c',
  'eye-highlight': '#f7f3e9',
  'mouth-dark': '#8f3f50',
  'mouth-inner': '#d6534d',
  'nose-base': '#b47a42',
})

function region(analysis, id) {
  return analysis?.semanticRegions?.find((entry) => entry.id === id)
}

function unavailable(id) {
  return {
    id,
    available: false,
    confidence: undefined,
    modelVersion: undefined,
    provenance: [],
    landmarks: [],
    placements: [],
  }
}

function evidenceLayer(id, evidence, modelVersion) {
  if (evidence?.mask === undefined) return unavailable(id)
  return {
    id,
    available: true,
    mask: evidence.mask,
    confidence: evidence.confidence,
    revision: evidence.revision,
    modelVersion,
    provenance: evidence.provenance ?? [],
    landmarks: [],
    placements: [],
  }
}

function semanticLayer(id, semanticRegion, modelVersion) {
  if (semanticRegion?.mask === undefined) return unavailable(id)
  return {
    id,
    available: true,
    mask: semanticRegion.mask,
    confidence: semanticRegion.confidence,
    modelVersion,
    provenance: semanticRegion.provenance ?? [],
    landmarks: [],
    placements: [],
  }
}

function importanceLayer(analysis) {
  const map = analysis?.importanceMap
  if (map?.weights === undefined) return unavailable('edges')
  return {
    id: 'edges',
    available: true,
    mask: { width: map.width, height: map.height, values: map.weights },
    confidence: analysis.confidence,
    modelVersion: analysis.modelVersions?.segmentation,
    provenance: analysis.provenance ?? [],
    landmarks: [],
    placements: [],
  }
}

function embeddingLayer(preferenceFeatures) {
  if (preferenceFeatures.length === 0) return unavailable('embedding')
  return {
    id: 'embedding',
    available: true,
    confidence: preferenceFeatures.reduce((sum, entry) => sum + entry.confidence, 0)
      / preferenceFeatures.length,
    modelVersion: preferenceFeatures.map((entry) => entry.modelId).join(' · '),
    provenance: [],
    landmarks: [],
    placements: [],
    detail: preferenceFeatures.flatMap((entry) => entry.names.map((name, index) =>
      `${name} ${Number(entry.values[index] ?? 0).toFixed(3)}`)).join(' · '),
  }
}

function combinedSkinLayer(analysis) {
  const face = region(analysis, 'face-skin')
  const body = region(analysis, 'body-skin')
  const available = [face, body].filter((entry) => entry?.mask !== undefined)
  if (available.length === 0) return unavailable('skin')
  const first = available[0]
  const width = first.mask.width
  const height = first.mask.height
  const values = new Float32Array(width * height)
  for (const entry of available) {
    if (entry.mask.width !== width || entry.mask.height !== height) {
      throw new RangeError('Skin semantic region dimensions must match')
    }
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.max(values[index], entry.mask.values[index] ?? 0)
    }
  }
  return {
    id: 'skin',
    available: true,
    mask: { width, height, values },
    confidence: available.reduce((sum, entry) => sum + entry.confidence, 0) / available.length,
    modelVersion: analysis.modelVersions?.portraitSemantics,
    provenance: available.flatMap((entry) => entry.provenance ?? []),
    landmarks: [],
    placements: [],
  }
}

function featureLayer(candidate) {
  const placements = candidate?.featurePlacements ?? []
  if (placements.length === 0 || candidate?.canvasPlan === undefined) return unavailable('features')
  return {
    id: 'features',
    available: true,
    confidence: placements.reduce((sum, placement) => sum + placement.score, 0) / placements.length,
    modelVersion: candidate.pattern?.metadata?.algorithmVersion,
    provenance: [],
    landmarks: [],
    placements,
    candidate,
  }
}

export function resolveAnalysisDebugLayer(id, {
  analysis,
  originalSubjectEvidence,
  candidate,
  preferenceFeatures = [],
}) {
  if (analysisDebugLayers.some((layer) => layer.id === id) === false) {
    throw new RangeError(`Unknown analysis debug layer: ${id}`)
  }
  if (id === 'original') {
    return {
      id,
      available: true,
      confidence: undefined,
      modelVersion: undefined,
      provenance: [],
      landmarks: [],
      placements: [],
    }
  }
  if (id === 'ai-subject') {
    return evidenceLayer(id, originalSubjectEvidence, analysis?.modelVersions?.segmentation)
  }
  if (id === 'corrected-subject') {
    const evidence = analysis?.subjectMaskEvidence?.userConfirmed === true
      ? analysis.subjectMaskEvidence
      : undefined
    return evidenceLayer(id, evidence, analysis?.modelVersions?.segmentation)
  }
  if (id === 'face') {
    return semanticLayer(id, region(analysis, 'face-skin'), analysis?.modelVersions?.portraitSemantics)
  }
  if (id === 'hair') {
    return semanticLayer(id, region(analysis, 'hair'), analysis?.modelVersions?.portraitSemantics)
  }
  if (id === 'skin') return combinedSkinLayer(analysis ?? {})
  if (id === 'clothes') {
    return semanticLayer(id, region(analysis, 'clothes'), analysis?.modelVersions?.portraitSemantics)
  }
  if (id === 'edges') return importanceLayer(analysis)
  if (id === 'depth') {
    return semanticLayer(id, (analysis?.semanticRegions ?? []).find((entry) =>
      entry.id === 'depth' || entry.label === 'depth'), analysis?.modelVersions?.depth)
  }
  if (id === 'embedding') return embeddingLayer(preferenceFeatures)
  if (id === 'features') return featureLayer(candidate)
  const landmarks = analysis?.landmarks ?? []
  return {
    id,
    available: landmarks.length > 0,
    confidence: landmarks.length === 0
      ? undefined
      : landmarks.reduce((sum, landmark) => sum + landmark.confidence, 0) / landmarks.length,
    modelVersion: analysis?.modelVersions?.faceLandmarks,
    provenance: landmarks.flatMap((landmark) => landmark.provenance ?? []),
    landmarks,
    placements: [],
  }
}

export function featureCellSourceRect(candidate, cell) {
  const size = candidate?.canvasPlan?.size
  const crop = candidate?.canvasPlan?.crop
  if (size === undefined || crop === undefined) throw new TypeError('Feature projection requires a canvas plan')
  if (Number.isInteger(cell) === false || cell < 0 || cell >= size.width * size.height) {
    throw new RangeError('Feature projection cell falls outside the target grid')
  }
  const scale = Math.min(size.width / crop.width, size.height / crop.height)
  const offsetX = (size.width - crop.width * scale) / 2
  const offsetY = (size.height - crop.height * scale) / 2
  const gridX = cell % size.width
  const gridY = Math.floor(cell / size.width)
  return {
    x: crop.x + (gridX - offsetX) / scale,
    y: crop.y + (gridY - offsetY) / scale,
    width: 1 / scale,
    height: 1 / scale,
  }
}

export function fitAnalysisDebugCanvas(sourceWidth, sourceHeight, viewportWidth, viewportHeight) {
  for (const [name, value] of Object.entries({ sourceWidth, sourceHeight, viewportWidth, viewportHeight })) {
    if (Number.isFinite(value) === false || value <= 0) throw new RangeError(`${name} must be positive`)
  }
  const scale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight)
  return { width: sourceWidth * scale, height: sourceHeight * scale }
}

export function applyCorrectedSubjectEvidence(analysis, evidence) {
  if (evidence?.mask?.values === undefined) {
    throw new TypeError('Corrected subject evidence must contain a mask')
  }
  const subject = evidence.mask
  const semanticRegions = (analysis?.semanticRegions ?? []).flatMap((entry) => {
    if (entry.id === 'subject') {
      return [{
        ...entry,
        mask: subject,
        confidence: evidence.confidence,
        ...(evidence.provenance === undefined ? {} : { provenance: evidence.provenance }),
      }]
    }
    if (entry.mask.width !== subject.width || entry.mask.height !== subject.height
      || entry.mask.values.length !== subject.values.length) {
      throw new RangeError(`Semantic region ${entry.id} dimensions must match corrected subject evidence`)
    }
    const values = new Float32Array(subject.values.length)
    let maximum = 0
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.min(1, Math.max(0, entry.mask.values[index] ?? 0))
        * Math.min(1, Math.max(0, subject.values[index] ?? 0))
      maximum = Math.max(maximum, values[index])
    }
    return maximum <= 0 ? [] : [{ ...entry, mask: { width: subject.width, height: subject.height, values } }]
  })
  return {
    ...analysis,
    subjectMask: subject,
    subjectMaskEvidence: evidence,
    ...(analysis?.semanticRegions === undefined ? {} : { semanticRegions }),
  }
}

function formatConfidence(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '--'
}

function provenanceText(provenance) {
  if (provenance.length === 0) return '--'
  return provenance.map((entry) => [entry.provider, entry.model, entry.version]
    .filter(Boolean).join(' / ')).filter(Boolean).join(' · ')
}

function layerLabel(id) {
  return analysisDebugLayers.find((layer) => layer.id === id)?.label ?? id
}

export function createAnalysisDebugViewer({ elements }) {
  let image
  let analysis = {}
  let originalSubjectEvidence
  let candidate
  let route = 'deterministic'
  let providers = []
  let contributions = []
  let preferenceFeatures = []
  let activeLayer = 'original'
  let selectedLandmarkId
  const sourceBuffer = document.createElement('canvas')
  const overlayBuffer = document.createElement('canvas')

  function state(id = activeLayer) {
    return resolveAnalysisDebugLayer(id, {
      analysis,
      originalSubjectEvidence,
      candidate,
      preferenceFeatures,
    })
  }

  function resize() {
    if (image === undefined || elements.dialog.open === false) return
    const viewport = elements.canvas.parentElement?.getBoundingClientRect()
    if (viewport === undefined || viewport.width <= 0 || viewport.height <= 0) return
    const fit = fitAnalysisDebugCanvas(image.width, image.height, viewport.width, viewport.height)
    elements.canvas.style.width = `${Math.max(1, fit.width)}px`
    elements.canvas.style.height = `${Math.max(1, fit.height)}px`
  }

  function prepareSource() {
    elements.canvas.width = image.width
    elements.canvas.height = image.height
    sourceBuffer.width = image.width
    sourceBuffer.height = image.height
    overlayBuffer.width = image.width
    overlayBuffer.height = image.height
    sourceBuffer.getContext('2d').putImageData(new ImageData(
      new Uint8ClampedArray(image.data),
      image.width,
      image.height,
    ), 0, 0)
  }

  function drawMask(mask, color) {
    if (mask.width !== image.width || mask.height !== image.height) {
      throw new RangeError('Analysis debug mask dimensions must match the source image')
    }
    const pixels = new Uint8ClampedArray(mask.values.length * 4)
    for (let index = 0; index < mask.values.length; index += 1) {
      const value = Math.min(1, Math.max(0, mask.values[index] ?? 0))
      const offset = index * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = Math.round(value * 148)
    }
    overlayBuffer.getContext('2d').putImageData(new ImageData(pixels, image.width, image.height), 0, 0)
    elements.canvas.getContext('2d').drawImage(overlayBuffer, 0, 0)
  }

  function drawLandmarks(landmarks) {
    const context = elements.canvas.getContext('2d')
    const scale = Math.max(1, Math.min(image.width, image.height) / 420)
    for (const landmark of landmarks) {
      const selected = landmark.id === selectedLandmarkId
      context.beginPath()
      context.arc(landmark.x, landmark.y, (selected ? 7 : 5) * scale, 0, Math.PI * 2)
      context.fillStyle = selected ? '#d6534d' : '#176f9c'
      context.fill()
      context.lineWidth = 2 * scale
      context.strokeStyle = '#ffffff'
      context.stroke()
    }
  }

  function drawFeatures(layer) {
    const context = elements.canvas.getContext('2d')
    const scale = Math.max(1, Math.min(image.width, image.height) / 420)
    for (const placement of layer.placements) {
      for (const entry of placement.roles) {
        const rect = featureCellSourceRect(layer.candidate, entry.cell)
        context.fillStyle = `${featureColors[entry.role] ?? '#176f9c'}cc`
        context.fillRect(rect.x, rect.y, rect.width, rect.height)
        context.lineWidth = Math.max(1, scale)
        context.strokeStyle = '#ffffff'
        context.strokeRect(rect.x, rect.y, rect.width, rect.height)
      }
    }
  }

  function selectedLandmark(layer) {
    return layer.landmarks.find((landmark) => landmark.id === selectedLandmarkId)
  }

  function renderMetadata(layer) {
    elements.title.textContent = layerLabel(activeLayer)
    elements.status.textContent = layer.placements.length > 0
      ? `${layer.placements.length} 个五官 · ${layer.placements.reduce((sum, placement) => sum + placement.occupiedCells.length, 0)} 格`
      : layer.available ? '图层已加载' : '当前分析未提供此图层'
    elements.confidence.textContent = formatConfidence(layer.confidence)
    elements.model.textContent = layer.modelVersion ?? '--'
    elements.provenance.textContent = provenanceText(layer.provenance)
    elements.provider.textContent = providers.length === 0
      ? route === 'deterministic' ? 'deterministic' : '--'
      : providers.join(' · ')
    elements.contributions.textContent = contributions.length === 0
      ? '--'
      : contributions.map((entry) => {
        const capabilities = entry.capabilities?.join(', ') ?? '--'
        return `${entry.providerId}: ${capabilities} · ${entry.status}`
      }).join(' · ')
    if (layer.detail !== undefined) {
      elements.status.textContent = layer.detail
    }
    const landmark = selectedLandmark(layer)
    elements.landmarkDetail.hidden = landmark === undefined
    if (landmark !== undefined) {
      elements.landmarkName.textContent = landmark.id
      elements.landmarkMeta.textContent = `${landmark.kind} · ${formatConfidence(landmark.confidence)} · ${landmark.priority}`
      elements.landmarkProvenance.textContent = provenanceText(landmark.provenance ?? [])
    }
  }

  function renderControls() {
    for (const button of elements.layerControl.querySelectorAll('button[data-analysis-layer]')) {
      const layer = state(button.dataset.analysisLayer)
      button.disabled = layer.available === false
      button.setAttribute('aria-pressed', String(button.dataset.analysisLayer === activeLayer))
      button.dataset.available = String(layer.available)
    }
  }

  function render() {
    if (image === undefined) return
    const layer = state()
    if (layer.available === false) activeLayer = 'original'
    const visible = state()
    const context = elements.canvas.getContext('2d')
    context.clearRect(0, 0, elements.canvas.width, elements.canvas.height)
    context.drawImage(sourceBuffer, 0, 0)
    if (visible.mask !== undefined) drawMask(visible.mask, colors[activeLayer])
    if (visible.landmarks.length > 0) drawLandmarks(visible.landmarks)
    if (visible.placements.length > 0) drawFeatures(visible)
    renderControls()
    renderMetadata(visible)
  }

  function preferredLayer() {
    if (state('corrected-subject').available) return 'corrected-subject'
    if (state('ai-subject').available) return 'ai-subject'
    return 'original'
  }

  elements.layerControl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-analysis-layer]')
    if (button === null || button.disabled) return
    activeLayer = button.dataset.analysisLayer
    selectedLandmarkId = undefined
    render()
  })
  elements.canvas.addEventListener('click', (event) => {
    const layer = state()
    if (layer.landmarks.length === 0) return
    const rect = elements.canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * image.width / rect.width
    const y = (event.clientY - rect.top) * image.height / rect.height
    const maximumDistance = 20 * image.width / rect.width
    const nearest = layer.landmarks
      .map((landmark) => ({ landmark, distance: Math.hypot(landmark.x - x, landmark.y - y) }))
      .toSorted((first, second) => first.distance - second.distance)[0]
    selectedLandmarkId = nearest?.distance <= maximumDistance ? nearest.landmark.id : undefined
    render()
  })
  elements.closeButton.addEventListener('click', () => elements.dialog.close())
  window.addEventListener('resize', resize)

  return {
    update(next) {
      image = next.image
      analysis = next.analysis ?? {}
      originalSubjectEvidence = next.originalSubjectEvidence
      candidate = next.candidate
      route = next.route ?? 'deterministic'
      providers = next.providers ?? []
      contributions = next.contributions ?? []
      preferenceFeatures = next.preferenceFeatures ?? []
      activeLayer = preferredLayer()
      selectedLandmarkId = undefined
      prepareSource()
      if (elements.dialog.open) {
        render()
        resize()
      }
    },
    open() {
      if (image === undefined) return
      activeLayer = preferredLayer()
      selectedLandmarkId = undefined
      render()
      elements.dialog.showModal()
      requestAnimationFrame(resize)
    },
    close() {
      elements.dialog.close()
    },
  }
}
