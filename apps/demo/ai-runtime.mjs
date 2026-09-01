const routeCapabilities = Object.freeze({
  deterministic: Object.freeze([]),
  'neural-analysis': Object.freeze(['subject-segmentation', 'edge-thin-structure']),
  'learned-pixelization': Object.freeze(['learned-pixelization']),
  'generative-proposal': Object.freeze(['generative-proposal']),
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
  return {
    route,
    capabilities: analysisCapabilitiesForRoute(route),
    image: {
      width: image.width,
      height: image.height,
      rgbaBase64: base64(image.data),
    },
    ...options,
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
      return {
        ...proposal,
        image: { ...proposal.image, data: Uint8ClampedArray.from(proposal.image.data) },
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
