const routeCapabilities = Object.freeze({
  deterministic: Object.freeze([]),
  'neural-analysis': Object.freeze(['subject-segmentation', 'edge-thin-structure']),
  'learned-pixelization': Object.freeze(['learned-pixelization']),
  'generative-proposal': Object.freeze(['generative-proposal']),
  'preference-scoring': Object.freeze(['embedding', 'preference-scoring']),
})

export function analysisCapabilitiesForRoute(route) {
  const capabilities = routeCapabilities[route]
  if (capabilities === undefined) throw new RangeError(`Unknown model route: ${route}`)
  return [...capabilities]
}

function base64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function pixelImageRequestBody(image, route, options = {}) {
  if (Number.isInteger(image?.width) === false || Number.isInteger(image?.height) === false
    || image.width <= 0 || image.height <= 0
    || image.data instanceof Uint8ClampedArray === false
    || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Pixel image must contain complete RGBA data')
  }
  const { referenceImage, ...requestOptions } = options
  return {
    route,
    capabilities: analysisCapabilitiesForRoute(route),
    image: {
      width: image.width,
      height: image.height,
      rgbaBase64: base64(image.data),
    },
    ...(referenceImage === undefined ? {} : {
      referenceImage: {
        width: referenceImage.width,
        height: referenceImage.height,
        rgbaBase64: base64(referenceImage.data),
      },
    }),
    ...requestOptions,
  }
}

function positiveInteger(value, label) {
  if (Number.isInteger(value) === false || value <= 0) {
    throw new RangeError(`${label} must use a positive integer`)
  }
  return value
}

function finiteNumber(value, label) {
  if (Number.isFinite(value) === false) throw new RangeError(`${label} must be finite`)
  return value
}

export function createContainSourceFrame(source, proposal) {
  const sourceWidth = positiveInteger(source?.width, 'Source width')
  const sourceHeight = positiveInteger(source?.height, 'Source height')
  const proposalWidth = positiveInteger(proposal?.width, 'Proposal width')
  const proposalHeight = positiveInteger(proposal?.height, 'Proposal height')
  const scale = Math.min(proposalWidth / sourceWidth, proposalHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    fit: 'contain',
    sourceWidth,
    sourceHeight,
    x: (proposalWidth - width) / 2,
    y: (proposalHeight - height) / 2,
    width,
    height,
  }
}

export function hydrateProposalSourceFrame(sourceFrame, proposalImage) {
  if (sourceFrame === null || typeof sourceFrame !== 'object' || Array.isArray(sourceFrame)) {
    throw new RangeError('Learned proposal source frame must be an object')
  }
  if (sourceFrame.fit !== 'contain') {
    throw new RangeError('Learned proposal source frame fit must use contain')
  }
  const sourceWidth = positiveInteger(sourceFrame.sourceWidth, 'Learned proposal source width')
  const sourceHeight = positiveInteger(sourceFrame.sourceHeight, 'Learned proposal source height')
  const proposalWidth = positiveInteger(proposalImage?.width, 'Learned proposal width')
  const proposalHeight = positiveInteger(proposalImage?.height, 'Learned proposal height')
  const hydrated = {
    fit: 'contain',
    sourceWidth,
    sourceHeight,
    x: finiteNumber(sourceFrame.x, 'Learned proposal source frame x'),
    y: finiteNumber(sourceFrame.y, 'Learned proposal source frame y'),
    width: finiteNumber(sourceFrame.width, 'Learned proposal source frame width'),
    height: finiteNumber(sourceFrame.height, 'Learned proposal source frame height'),
  }
  if (hydrated.x < 0 || hydrated.y < 0 || hydrated.width <= 0 || hydrated.height <= 0
    || hydrated.x + hydrated.width > proposalWidth + 1e-6
    || hydrated.y + hydrated.height > proposalHeight + 1e-6) {
    throw new RangeError('Learned proposal source frame must stay inside the proposal image')
  }
  const expected = createContainSourceFrame(
    { width: sourceWidth, height: sourceHeight },
    { width: proposalWidth, height: proposalHeight },
  )
  const tolerance = Math.max(0.01, Math.max(proposalWidth, proposalHeight) / 512)
  if (Math.abs(hydrated.x - expected.x) > tolerance
    || Math.abs(hydrated.y - expected.y) > tolerance
    || Math.abs(hydrated.width - expected.width) > tolerance
    || Math.abs(hydrated.height - expected.height) > tolerance) {
    throw new RangeError('Learned proposal source frame must describe a centered contain mapping')
  }
  return hydrated
}

function sourceField(values, width, height, label) {
  const isArrayLike = Array.isArray(values) || ArrayBuffer.isView(values)
  if (isArrayLike === false || values.length !== width * height) {
    throw new RangeError(`${label} values differ from source dimensions`)
  }
  const typed = Float32Array.from(values)
  if ([...typed].some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError(`${label} values must stay within 0..1`)
  }
  return typed
}

function projectedScalarField(values, frame, proposal, interpolation) {
  const output = new Float32Array(proposal.width * proposal.height)
  const sourceValues = sourceField(
    values,
    frame.sourceWidth,
    frame.sourceHeight,
    'Source analysis field',
  )
  const scaleX = frame.sourceWidth / frame.width
  const scaleY = frame.sourceHeight / frame.height
  for (let y = 0; y < proposal.height; y += 1) {
    const proposalCenterY = y + 0.5
    if (proposalCenterY < frame.y || proposalCenterY >= frame.y + frame.height) continue
    const sourceY = (proposalCenterY - frame.y) * scaleY - 0.5
    for (let x = 0; x < proposal.width; x += 1) {
      const proposalCenterX = x + 0.5
      if (proposalCenterX < frame.x || proposalCenterX >= frame.x + frame.width) continue
      const sourceX = (proposalCenterX - frame.x) * scaleX - 0.5
      if (interpolation === 'nearest') {
        const nearestX = Math.max(0, Math.min(frame.sourceWidth - 1, Math.round(sourceX)))
        const nearestY = Math.max(0, Math.min(frame.sourceHeight - 1, Math.round(sourceY)))
        output[y * proposal.width + x] = sourceValues[nearestY * frame.sourceWidth + nearestX]
        continue
      }
      const clampedSourceX = Math.max(0, Math.min(frame.sourceWidth - 1, sourceX))
      const clampedSourceY = Math.max(0, Math.min(frame.sourceHeight - 1, sourceY))
      const left = Math.floor(clampedSourceX)
      const top = Math.floor(clampedSourceY)
      const right = Math.min(frame.sourceWidth - 1, left + 1)
      const bottom = Math.min(frame.sourceHeight - 1, top + 1)
      const xWeight = clampedSourceX - left
      const yWeight = clampedSourceY - top
      const topValue = sourceValues[top * frame.sourceWidth + left] * (1 - xWeight)
        + sourceValues[top * frame.sourceWidth + right] * xWeight
      const bottomValue = sourceValues[bottom * frame.sourceWidth + left] * (1 - xWeight)
        + sourceValues[bottom * frame.sourceWidth + right] * xWeight
      output[y * proposal.width + x] = topValue * (1 - yWeight) + bottomValue * yWeight
    }
  }
  return output
}

function projectedMask(mask, frame, proposal) {
  if (mask?.width !== frame.sourceWidth || mask?.height !== frame.sourceHeight) {
    throw new RangeError('Source analysis mask dimensions differ from the proposal source frame')
  }
  return {
    width: proposal.width,
    height: proposal.height,
    values: projectedScalarField(mask.values, frame, proposal, 'nearest'),
  }
}

export function projectSourceAnalysisToProposal(sourceAnalysis = {}, proposal) {
  const proposalImage = proposal?.image
  const frame = hydrateProposalSourceFrame(proposal?.sourceFrame, proposalImage)
  const scaleX = frame.width / frame.sourceWidth
  const scaleY = frame.height / frame.sourceHeight
  if (sourceAnalysis.importanceMap !== undefined
    && (sourceAnalysis.importanceMap.width !== frame.sourceWidth
      || sourceAnalysis.importanceMap.height !== frame.sourceHeight)) {
    throw new RangeError('Source importance dimensions differ from the proposal source frame')
  }
  return {
    ...sourceAnalysis,
    ...(sourceAnalysis.subjectMask === undefined ? {} : {
      subjectMask: projectedMask(sourceAnalysis.subjectMask, frame, proposalImage),
    }),
    ...(sourceAnalysis.subjectMaskEvidence === undefined ? {} : {
      subjectMaskEvidence: {
        ...sourceAnalysis.subjectMaskEvidence,
        mask: projectedMask(sourceAnalysis.subjectMaskEvidence.mask, frame, proposalImage),
      },
    }),
    ...(sourceAnalysis.semanticRegions === undefined ? {} : {
      semanticRegions: sourceAnalysis.semanticRegions.map((region) => ({
        ...region,
        mask: projectedMask(region.mask, frame, proposalImage),
      })),
    }),
    ...(sourceAnalysis.importanceMap === undefined ? {} : {
      importanceMap: {
        width: proposalImage.width,
        height: proposalImage.height,
        weights: projectedScalarField(
          sourceAnalysis.importanceMap.weights,
          frame,
          proposalImage,
          'bilinear',
        ),
      },
    }),
    ...(sourceAnalysis.landmarks === undefined ? {} : {
      landmarks: sourceAnalysis.landmarks.map((landmark) => ({
        ...landmark,
        x: frame.x + (landmark.x + 0.5) * scaleX - 0.5,
        y: frame.y + (landmark.y + 0.5) * scaleY - 0.5,
        ...(landmark.sourceRadiusPx === undefined ? {} : {
          sourceRadiusPx: landmark.sourceRadiusPx * (scaleX + scaleY) / 2,
        }),
        ...(landmark.radius === undefined ? {} : {
          radius: landmark.radius * (scaleX + scaleY) / 2,
        }),
      })),
    }),
    ...(sourceAnalysis.suggestedCrop === undefined ? {} : {
      suggestedCrop: {
        x: frame.x + sourceAnalysis.suggestedCrop.x * scaleX,
        y: frame.y + sourceAnalysis.suggestedCrop.y * scaleY,
        width: sourceAnalysis.suggestedCrop.width * scaleX,
        height: sourceAnalysis.suggestedCrop.height * scaleY,
      },
    }),
  }
}

function hydrateMask(mask) {
  if (mask === undefined) return undefined
  if (Number.isInteger(mask.width) === false || Number.isInteger(mask.height) === false
    || mask.width <= 0 || mask.height <= 0
    || Array.isArray(mask.values) === false
    || mask.values.length !== mask.width * mask.height
    || mask.values.some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError('AI mask values differ from their dimensions')
  }
  return { ...mask, values: Float32Array.from(mask.values) }
}

function hydrateAnalysis(analysis = {}) {
  return {
    ...analysis,
    ...(analysis.subjectMask === undefined ? {} : { subjectMask: hydrateMask(analysis.subjectMask) }),
    ...(analysis.subjectMaskEvidence === undefined ? {} : {
      subjectMaskEvidence: {
        ...analysis.subjectMaskEvidence,
        mask: hydrateMask(analysis.subjectMaskEvidence.mask),
      },
    }),
    ...(analysis.importanceMap === undefined ? {} : {
      importanceMap: {
        ...analysis.importanceMap,
        weights: hydrateMask({
          width: analysis.importanceMap.width,
          height: analysis.importanceMap.height,
          values: analysis.importanceMap.weights,
        }).values,
      },
    }),
    ...(analysis.semanticRegions === undefined ? {} : {
      semanticRegions: analysis.semanticRegions.map((entry) => ({
        ...entry,
        mask: hydrateMask(entry.mask),
      })),
    }),
  }
}

export function hydrateAiAnalysisResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('AI analysis response must be an object')
  }
  return {
    ...result,
    analysis: hydrateAnalysis(result.analysis),
    learnedProposals: (result.learnedProposals ?? []).map((proposal) => {
      if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)
        || typeof proposal.id !== 'string' || proposal.id.trim().length === 0
        || typeof proposal.modelId !== 'string' || proposal.modelId.trim().length === 0
        || (proposal.kind !== 'learned-pixelization' && proposal.kind !== 'generative-proposal')) {
        throw new RangeError('Learned proposal identity and kind are invalid')
      }
      if (Number.isFinite(proposal.confidence) === false
        || proposal.confidence < 0 || proposal.confidence > 1) {
        throw new RangeError('Learned proposal confidence must stay within 0..1')
      }
      if (proposal.targetGrid !== undefined
        && (Number.isInteger(proposal.targetGrid.width) === false
          || Number.isInteger(proposal.targetGrid.height) === false
          || proposal.targetGrid.width <= 0 || proposal.targetGrid.height <= 0)) {
        throw new RangeError('Learned proposal target grid must use positive integer dimensions')
      }
      if (Number.isInteger(proposal.image?.width) === false
        || Number.isInteger(proposal.image?.height) === false
        || proposal.image.width <= 0 || proposal.image.height <= 0
        || Array.isArray(proposal.image.data) === false
        || proposal.image.data.length !== proposal.image.width * proposal.image.height * 4
        || proposal.image.data.some((value) => Number.isInteger(value) === false || value < 0 || value > 255)) {
        throw new RangeError('Learned proposal RGBA data differs from its dimensions or value range')
      }
      const image = {
        ...proposal.image,
        data: Uint8ClampedArray.from(proposal.image.data),
      }
      return {
        ...proposal,
        image,
        sourceFrame: hydrateProposalSourceFrame(proposal.sourceFrame, image),
      }
    }),
    preferenceFeatures: (result.preferenceFeatures ?? []).map((features) => {
      if (Array.isArray(features.names) === false || Array.isArray(features.values) === false
        || features.names.length === 0 || features.names.length !== features.values.length
        || features.values.some((value) => Number.isFinite(value) === false)) {
        throw new RangeError('Preference features names and values must align')
      }
      return { ...features, values: Float32Array.from(features.values) }
    }),
  }
}

export function routeAvailability(health, route) {
  analysisCapabilitiesForRoute(route)
  return health?.routes?.[route] ?? { available: false, status: 'checking', providers: [] }
}

export function selectLearnedProposal(proposals, route) {
  if (route !== 'learned-pixelization' && route !== 'generative-proposal') return undefined
  return [...(proposals ?? [])]
    .filter((proposal) => proposal.kind === route)
    .sort((first, second) => second.confidence - first.confidence
      || first.id.localeCompare(second.id))[0]
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}))
  if (response.ok === false) throw new Error(body.error ?? `AI request returned ${response.status}`)
  return body
}

export async function fetchAiHealth(options = {}) {
  const response = await fetch(options.endpoint ?? '/api/ai/health', {
    signal: options.signal,
    cache: 'no-store',
  })
  return responseJson(response)
}

export async function runAiRoute(image, route, options = {}) {
  const endpoint = route === 'learned-pixelization' || route === 'generative-proposal'
    ? '/api/ai/proposals'
    : '/api/ai/analyze'
  const response = await fetch(options.endpoint ?? endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pixelImageRequestBody(image, route, options.request ?? {})),
    signal: options.signal,
  })
  return hydrateAiAnalysisResult(await responseJson(response))
}
