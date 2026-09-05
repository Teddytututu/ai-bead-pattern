function endpoint(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function timeout(value, label, maximum = Number.POSITIVE_INFINITY) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    throw new RangeError(`${label} must be a positive number`)
  }
  if (parsed > maximum) throw new RangeError(`${label} must stay within the model limit`)
  return parsed
}

export function candidateProviderOptions(values, environment = process.env) {
  const openClipEndpoint = endpoint(
    values['openclip-endpoint'] ?? environment.OPENCLIP_ENDPOINT,
    'OpenCLIP endpoint',
  )
  const openClipTimeoutMs = timeout(values['openclip-timeout-ms'], 'OpenCLIP timeout')
  const dinoV2Endpoint = endpoint(
    values['dinov2-endpoint'] ?? environment.DINOV2_ENDPOINT,
    'DINOv2 endpoint',
  )
  const dinoV2TimeoutMs = timeout(values['dinov2-timeout-ms'], 'DINOv2 timeout')
  const groundedSam2Endpoint = endpoint(
    values['grounded-sam2-endpoint'] ?? environment.GROUNDED_SAM2_ENDPOINT,
    'Grounded-SAM2 endpoint',
  )
  const groundedSam2TimeoutMs = timeout(
    values['grounded-sam2-timeout-ms'] ?? environment.GROUNDED_SAM2_TIMEOUT_MS,
    'Grounded-SAM2 timeout',
    60_000,
  )
  const mmposeEndpoint = endpoint(
    values['mmpose-endpoint'] ?? environment.MMPOSE_ENDPOINT,
    'MMPose endpoint',
  )
  const mmposeTimeoutMs = timeout(
    values['mmpose-timeout-ms'] ?? environment.MMPOSE_TIMEOUT_MS,
    'MMPose timeout',
    30_000,
  )
  if ((groundedSam2Endpoint === undefined) !== (mmposeEndpoint === undefined)) {
    throw new RangeError('Grounded-SAM2 and MMPose endpoints must be configured together')
  }
  return {
    ...(openClipEndpoint === undefined ? {} : { openClipEndpoint }),
    ...(openClipTimeoutMs === undefined ? {} : { openClipTimeoutMs }),
    ...(dinoV2Endpoint === undefined ? {} : { dinoV2Endpoint }),
    ...(dinoV2TimeoutMs === undefined ? {} : { dinoV2TimeoutMs }),
    ...(groundedSam2Endpoint === undefined ? {} : { groundedSam2Endpoint }),
    ...(groundedSam2TimeoutMs === undefined ? {} : { groundedSam2TimeoutMs }),
    ...(mmposeEndpoint === undefined ? {} : { mmposeEndpoint }),
    ...(mmposeTimeoutMs === undefined ? {} : { mmposeTimeoutMs }),
  }
}
