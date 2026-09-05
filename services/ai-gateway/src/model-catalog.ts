export type AICapability =
  | 'subject-segmentation'
  | 'keypoints'
  | 'semantic-parsing'
  | 'embedding'
  | 'depth'
  | 'edge-thin-structure'
  | 'material'
  | 'learned-pixelization'
  | 'generative-proposal'
  | 'preference-scoring'

export interface ModelLicense {
  spdx: string
  name: string
  url: string
}

export interface ModelInputLimits {
  minimumWidth: number
  minimumHeight: number
  maximumWidth: number
  maximumHeight: number
  preferredWidth: number
  preferredHeight: number
  colorSpace: 'srgb'
}

export interface ModelExecutionProfile {
  location: 'local' | 'remote' | 'local-or-remote'
  devices: readonly ('cpu' | 'cuda' | 'mps' | 'webgpu' | 'remote')[]
  estimatedMemoryMiB?: number
  estimatedLatencyMs?: Readonly<{ p50: number; p95: number }>
  measurement: 'upstream' | 'local' | 'unmeasured'
  notes?: string
}

export interface ModelPrivacyProfile {
  imageLeavesDevice: boolean
  retention: 'none' | 'provider-policy' | 'deployment-controlled'
  notes?: string
}

export interface ModelFailurePolicy {
  timeoutMs: number
  maximumResponseBytes: number
  retryCount: number
  fallback: 'deterministic-baseline' | 'skip-capability' | 'manual-review'
}

export interface ModelManifest {
  providerId: string
  modelId: string
  modelVersion: string
  /** Immutable upstream source revision. */
  sourceRevision: string
  weightSource: string
  /** Immutable checkpoint revision or content hash. */
  weightRevision: string
  license: ModelLicense
  weightLicense?: ModelLicense
  documentationUrl: string
  capabilities: readonly AICapability[]
  input: ModelInputLimits
  execution: ModelExecutionProfile
  privacy: ModelPrivacyProfile
  failurePolicy: ModelFailurePolicy
}

const capabilities = new Set<AICapability>([
  'subject-segmentation',
  'keypoints',
  'semantic-parsing',
  'embedding',
  'depth',
  'edge-thin-structure',
  'material',
  'learned-pixelization',
  'generative-proposal',
  'preference-scoring',
])

function finitePositive(value: number, label: string): void {
  if (Number.isFinite(value) === false || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`)
  }
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label} must be non-empty`)
}

function secureUrl(value: string, label: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new RangeError(`${label} must use HTTPS`)
}

export function validateModelManifest(manifest: ModelManifest): void {
  nonEmpty(manifest.providerId, 'Provider id')
  nonEmpty(manifest.modelId, 'Model id')
  nonEmpty(manifest.modelVersion, 'Model version')
  if (/^[a-f0-9]{40}$/.test(manifest.sourceRevision) === false) {
    throw new RangeError('Model source revision must be a 40-character commit hash')
  }
  secureUrl(manifest.weightSource, 'Model weight source')
  nonEmpty(manifest.weightRevision, 'Model weight revision')
  if (manifest.weightRevision === 'latest' || manifest.weightRevision === 'main') {
    throw new RangeError('Model weight revision must be immutable')
  }
  if (manifest.license.spdx.trim().length === 0 || manifest.license.spdx === 'NOASSERTION') {
    throw new RangeError('Model license must be explicit')
  }
  secureUrl(manifest.license.url, 'Model license URL')
  if (manifest.weightLicense !== undefined) {
    if (manifest.weightLicense.spdx.trim().length === 0
      || manifest.weightLicense.spdx === 'NOASSERTION') {
      throw new RangeError('Model weight license must be explicit')
    }
    secureUrl(manifest.weightLicense.url, 'Model weight license URL')
  }
  secureUrl(manifest.documentationUrl, 'Model documentation URL')
  if (manifest.capabilities.length === 0
    || new Set(manifest.capabilities).size !== manifest.capabilities.length
    || manifest.capabilities.some((capability) => capabilities.has(capability) === false)) {
    throw new RangeError('Model capabilities must contain unique supported values')
  }
  finitePositive(manifest.input.minimumWidth, 'Model input minimum width')
  finitePositive(manifest.input.minimumHeight, 'Model input minimum height')
  finitePositive(manifest.input.maximumWidth, 'Model input maximum width')
  finitePositive(manifest.input.maximumHeight, 'Model input maximum height')
  finitePositive(manifest.input.preferredWidth, 'Model input preferred width')
  finitePositive(manifest.input.preferredHeight, 'Model input preferred height')
  if (manifest.input.minimumWidth > manifest.input.maximumWidth
    || manifest.input.minimumHeight > manifest.input.maximumHeight
    || manifest.input.preferredWidth > manifest.input.maximumWidth
    || manifest.input.preferredHeight > manifest.input.maximumHeight) {
    throw new RangeError('Model input limits must form a valid range')
  }
  if (manifest.execution.devices.length === 0) {
    throw new RangeError('Model execution devices must be declared')
  }
  if (manifest.execution.estimatedMemoryMiB !== undefined) {
    finitePositive(manifest.execution.estimatedMemoryMiB, 'Model memory estimate')
  }
  if (manifest.execution.estimatedLatencyMs !== undefined) {
    finitePositive(manifest.execution.estimatedLatencyMs.p50, 'Model P50 latency')
    finitePositive(manifest.execution.estimatedLatencyMs.p95, 'Model P95 latency')
    if (manifest.execution.estimatedLatencyMs.p95 < manifest.execution.estimatedLatencyMs.p50) {
      throw new RangeError('Model P95 latency must be at least P50')
    }
  }
  finitePositive(manifest.failurePolicy.timeoutMs, 'Model timeout')
  finitePositive(manifest.failurePolicy.maximumResponseBytes, 'Model response limit')
  if (Number.isInteger(manifest.failurePolicy.retryCount) === false
    || manifest.failurePolicy.retryCount < 0
    || manifest.failurePolicy.retryCount > 3) {
    throw new RangeError('Model retry count must stay within 0..3')
  }
}

const mit: ModelLicense = {
  spdx: 'MIT',
  name: 'MIT License',
  url: 'https://opensource.org/license/mit',
}

const apache: ModelLicense = {
  spdx: 'Apache-2.0',
  name: 'Apache License 2.0',
  url: 'https://www.apache.org/licenses/LICENSE-2.0',
}

const localPrivacy: ModelPrivacyProfile = {
  imageLeavesDevice: false,
  retention: 'none',
}

const externalPrivacy: ModelPrivacyProfile = {
  imageLeavesDevice: true,
  retention: 'deployment-controlled',
  notes: 'Remote deployments must publish retention and deletion controls.',
}

function failure(
  timeoutMs: number,
  maximumResponseBytes = 64 * 1024 * 1024,
): ModelFailurePolicy {
  return {
    timeoutMs,
    maximumResponseBytes,
    retryCount: 0,
    fallback: 'deterministic-baseline',
  }
}

/**
 * Frozen model identities reviewed from official repositories and model cards on 2026-08-31.
 * Catalog entries describe deployable providers; an entry alone never claims that its runtime is installed.
 */
export const MODEL_CATALOG: readonly ModelManifest[] = [
  {
    providerId: 'rembg-birefnet-general-lite',
    modelId: 'rembg/birefnet-general-lite',
    modelVersion: 'rembg-2.0.81',
    sourceRevision: 'b439167d2eb22e51e7ec0732efe771bf920ff5c1',
    weightSource: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
    weightRevision: 'sha256:5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
    license: mit,
    weightLicense: mit,
    documentationUrl: 'https://github.com/danielgatis/rembg/tree/v2.0.81',
    capabilities: ['subject-segmentation', 'edge-thin-structure'],
    input: {
      minimumWidth: 1,
      minimumHeight: 1,
      maximumWidth: 2048,
      maximumHeight: 2048,
      preferredWidth: 1024,
      preferredHeight: 1024,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cpu', 'cuda', 'remote'],
      estimatedMemoryMiB: 3450,
      measurement: 'upstream',
      notes: 'BiRefNet reports 17 FPS at 1024px FP16 on RTX 4090; CPU P50/P95 need local measurement.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(30_000),
  },
  {
    providerId: 'sam2-local',
    modelId: 'facebook/sam2.1-hiera-small',
    modelVersion: 'transformers-5.16.1+sam2.1',
    sourceRevision: '93c8b7b485963a10800c91f55304db6be211c2bd',
    weightSource: 'https://huggingface.co/facebook/sam2.1-hiera-small/tree/ee5bba1d82bb8749febdf90f45e84b687142ba03',
    weightRevision: 'hf:ee5bba1d82bb8749febdf90f45e84b687142ba03',
    license: apache,
    weightLicense: apache,
    documentationUrl: 'https://github.com/huggingface/transformers/tree/v5.16.1/src/transformers/models/sam2',
    capabilities: ['subject-segmentation', 'edge-thin-structure'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 1024,
      preferredHeight: 1024,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cpu', 'cuda', 'remote'],
      measurement: 'unmeasured',
      notes: 'Transformers 5.16.1 provides the pinned prompt processor; upstream SAM 2 is fixed at 2b90b9f5ceec907a1c18123530e92e794ad901a4.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(45_000),
  },
  {
    providerId: 'grounded-sam2-local',
    modelId: 'IDEA-Research/grounding-dino-tiny+facebook/sam2.1-hiera-small',
    modelVersion: 'transformers-5.16.1+grounded-sam2-1.0',
    sourceRevision: 'dd4c5141b75e4838dd486c64f773c43b4db3a07b',
    weightSource: 'https://huggingface.co/IDEA-Research/grounding-dino-tiny/tree/a2bb814dd30d776dcf7e30523b00659f4f141c71',
    weightRevision: 'hf:a2bb814dd30d776dcf7e30523b00659f4f141c71+hf:ee5bba1d82bb8749febdf90f45e84b687142ba03',
    license: apache,
    weightLicense: apache,
    documentationUrl: 'https://github.com/IDEA-Research/Grounded-SAM-2/tree/dd4c5141b75e4838dd486c64f773c43b4db3a07b',
    capabilities: ['subject-segmentation', 'edge-thin-structure'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 1024,
      preferredHeight: 1024,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cpu', 'cuda', 'remote'],
      measurement: 'unmeasured',
      notes: 'GroundingDINO source 856dde20aee659246248e20734ef9ba5214f5e44 detects text-grounded boxes; one SAM 2.1 batch segments every retained box.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(60_000),
  },
  {
    providerId: 'mediapipe-face-local',
    modelId: 'mediapipe/face-landmarker-float16',
    modelVersion: 'mediapipe-1.0.1',
    sourceRevision: '251c0cb9687230682929a64d413751f1a4f8a6d5',
    weightSource: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    weightRevision: 'sha256:64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    license: apache,
    documentationUrl: 'https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker',
    capabilities: ['keypoints'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 256,
      preferredHeight: 256,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'webgpu'],
      measurement: 'unmeasured',
      notes: 'The 3.6 MB task asset is pinned by content hash; browser and CPU latency need local measurement.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(10_000, 8 * 1024 * 1024),
  },
  {
    providerId: 'mediapipe-pose-local',
    modelId: 'mediapipe/pose-landmarker-lite-float16',
    modelVersion: 'mediapipe-1.0.1',
    sourceRevision: '251c0cb9687230682929a64d413751f1a4f8a6d5',
    weightSource: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
    weightRevision: 'sha256:59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
    license: apache,
    documentationUrl: 'https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker',
    capabilities: ['keypoints'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 256,
      preferredHeight: 256,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'webgpu'],
      measurement: 'unmeasured',
      notes: 'The 5.5 MB task asset is pinned by content hash; latency needs local measurement.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(10_000, 8 * 1024 * 1024),
  },
  {
    providerId: 'mediapipe-selfie-multiclass-local',
    modelId: 'mediapipe/selfie-multiclass-256x256',
    modelVersion: 'mediapipe-1.0.1',
    sourceRevision: '251c0cb9687230682929a64d413751f1a4f8a6d5',
    weightSource: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    weightRevision: 'sha256:c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
    license: apache,
    documentationUrl: 'https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter',
    capabilities: ['semantic-parsing'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 256,
      preferredHeight: 256,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'webgpu'],
      measurement: 'unmeasured',
      notes: 'The 15.6 MB TFLite asset is pinned by content hash; latency needs local measurement.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(15_000, 32 * 1024 * 1024),
  },
  {
    providerId: 'mmpose-animal-local',
    modelId: 'open-mmlab/rtmpose-m-ap10k-onnx',
    modelVersion: 'mmpose-v1.3.2+onnx-sdk-20230831',
    sourceRevision: '5408bc76f5b848cf925a0d1857899011d8c5b497',
    weightSource: 'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-ap10k_pt-aic-coco_210e-256x256-7a041aa1_20230206.zip',
    weightRevision: 'sha256:1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28',
    license: apache,
    weightLicense: apache,
    documentationUrl: 'https://github.com/open-mmlab/mmpose/tree/5408bc76f5b848cf925a0d1857899011d8c5b497/configs/animal_2d_keypoint/rtmpose/ap10k',
    capabilities: ['keypoints'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 256,
      preferredHeight: 256,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'cuda'],
      measurement: 'unmeasured',
      notes: 'One ONNX Runtime call batches 1..64 detected pet boxes at 256x256; AP-10K dataset attribution remains CC-BY-4.0.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(30_000),
  },
  {
    providerId: 'dinov2-vits14-pair-local',
    modelId: 'facebook/dinov2-small',
    modelVersion: 'transformers-5.16.1+dinov2-vits14',
    sourceRevision: '7764ea0f912e53c92e82eb78a2a1631e92725fc8',
    weightSource: 'https://huggingface.co/facebook/dinov2-small/tree/ed25f3a31f01632728cabb09d1542f84ab7b0056',
    weightRevision: 'hf:ed25f3a31f01632728cabb09d1542f84ab7b0056',
    license: apache,
    weightLicense: apache,
    documentationUrl: 'https://github.com/facebookresearch/dinov2/tree/7764ea0f912e53c92e82eb78a2a1631e92725fc8',
    capabilities: ['embedding', 'preference-scoring'],
    input: {
      minimumWidth: 14,
      minimumHeight: 14,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 224,
      preferredHeight: 224,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'cuda', 'mps'],
      estimatedMemoryMiB: 1024,
      estimatedLatencyMs: { p50: 500, p95: 40_000 },
      measurement: 'local',
      notes: 'One batch compares global, subject, head, and critical-local views. Windows CPU cold inference measured near 10 seconds after weight caching; model load and first-run variance remain inside the 120 second provider budget.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(120_000, 8 * 1024 * 1024),
  },
  {
    providerId: 'openclip-vit-b32-pair-local',
    modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
    modelVersion: 'open_clip_torch-3.3.0',
    sourceRevision: '30573618fc375b12f094ef64cb3a1391cf611c45',
    weightSource: 'https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/tree/1a25a446712ba5ee05982a381eed697ef9b435cf',
    weightRevision: 'hf:1a25a446712ba5ee05982a381eed697ef9b435cf',
    license: mit,
    weightLicense: mit,
    documentationUrl: 'https://github.com/mlfoundations/open_clip/tree/v3.3.0',
    capabilities: ['embedding', 'preference-scoring'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 224,
      preferredHeight: 224,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cpu', 'cuda', 'mps'],
      estimatedMemoryMiB: 1024,
      measurement: 'unmeasured',
      notes: 'Pair scoring encodes the source and candidate with the same normalized ViT-B-32 image tower.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(20_000, 8 * 1024 * 1024),
  },
  {
    providerId: 'siglip-material-remote',
    modelId: 'google/siglip-base-patch16-224',
    modelVersion: 'transformers-5.16.1',
    sourceRevision: '0127fb6b337ee2a27bf4e54dea79cff176527356',
    weightSource: 'https://huggingface.co/google/siglip-base-patch16-224',
    weightRevision: 'hf:7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed',
    license: apache,
    documentationUrl: 'https://github.com/google-research/big_vision',
    capabilities: ['embedding', 'material'],
    input: {
      minimumWidth: 16,
      minimumHeight: 16,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 224,
      preferredHeight: 224,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cpu', 'cuda', 'mps', 'remote'],
      measurement: 'unmeasured',
      notes: 'Material labels use zero-shot prompts or a project head and need holdout calibration.',
    },
    privacy: externalPrivacy,
    failurePolicy: failure(20_000, 8 * 1024 * 1024),
  },
  {
    providerId: 'depth-anything-v2-small-remote',
    modelId: 'depth-anything/Depth-Anything-V2-Small-hf',
    modelVersion: 'transformers-5.16.1',
    sourceRevision: 'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf',
    weightSource: 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf',
    weightRevision: 'hf:5426e4f0f36572d16453bbda7a8389317b1bef99',
    license: apache,
    documentationUrl: 'https://github.com/DepthAnything/Depth-Anything-V2',
    capabilities: ['depth'],
    input: {
      minimumWidth: 14,
      minimumHeight: 14,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 518,
      preferredHeight: 518,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cpu', 'cuda', 'mps', 'remote'],
      measurement: 'unmeasured',
      notes: 'Only the Small checkpoint uses Apache-2.0; larger checkpoints carry different terms.',
    },
    privacy: externalPrivacy,
    failurePolicy: failure(30_000, 32 * 1024 * 1024),
  },
  {
    providerId: 'pixel-art-sprite-lcm-local',
    modelId: 'Onodofthenorth/SD_PixelArt_SpriteSheet_Generator+latent-consistency/lcm-lora-sdv1-5',
    modelVersion: 'diffusers-0.35.2',
    sourceRevision: 'b71269675ec1b85193107a691dd35c308e46f0a5',
    weightSource: 'https://huggingface.co/Onodofthenorth/SD_PixelArt_SpriteSheet_Generator/tree/8229c9b6e928103f0e657cfe6b14d902cb2101d6',
    weightRevision: 'hf:pixel-art-sprite@8229c9b6e928103f0e657cfe6b14d902cb2101d6+lcm-lora-sdv1-5@cf2fced511dbe7e26c8d1d397e728fbab875db4b',
    license: apache,
    weightLicense: {
      spdx: 'LicenseRef-Apache-2.0-OpenRAIL++',
      name: 'Apache-2.0 pixel checkpoint with OpenRAIL++ LCM adapter',
      url: 'https://huggingface.co/Onodofthenorth/SD_PixelArt_SpriteSheet_Generator/blob/8229c9b6e928103f0e657cfe6b14d902cb2101d6/README.md',
    },
    documentationUrl: 'https://huggingface.co/docs/diffusers/v0.35.2/en/api/pipelines/stable_diffusion/overview',
    capabilities: ['learned-pixelization', 'generative-proposal'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 2048,
      maximumHeight: 2048,
      preferredWidth: 512,
      preferredHeight: 512,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local',
      devices: ['cuda'],
      estimatedMemoryMiB: 6 * 1024,
      estimatedLatencyMs: { p50: 20_000, p95: 90_000 },
      measurement: 'unmeasured',
      notes: 'The pixel checkpoint declares Apache-2.0 and the LCM adapter declares OpenRAIL++. Sequential model CPU offload and VAE tiling target 8 GB CUDA devices.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(30 * 60_000, 96 * 1024 * 1024),
  },
]

for (const manifest of MODEL_CATALOG) validateModelManifest(manifest)

/** Research references that fail the production maintenance or runtime-cost gate. */
export const RESEARCH_MODEL_CATALOG: readonly ModelManifest[] = [
  {
    providerId: 'sd-pixl-research',
    modelId: 'AlexandreBinninger/SD-piXL',
    modelVersion: 'siggraph-asia-2024',
    sourceRevision: '0b84fbe77efbb5933a413d4294e53179c242ec14',
    weightSource: 'https://github.com/AlexandreBinninger/SD-piXL/tree/0b84fbe77efbb5933a413d4294e53179c242ec14',
    weightRevision: 'runtime-manifest-required:sdxl+controlnet+vae',
    license: mit,
    weightLicense: {
      spdx: 'LicenseRef-CreativeML-OpenRAIL-M',
      name: 'CreativeML Open RAIL-M',
      url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
    },
    documentationUrl: 'https://github.com/AlexandreBinninger/SD-piXL',
    capabilities: ['learned-pixelization', 'generative-proposal'],
    input: {
      minimumWidth: 16,
      minimumHeight: 16,
      maximumWidth: 4096,
      maximumHeight: 4096,
      preferredWidth: 64,
      preferredHeight: 64,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'remote',
      devices: ['cuda', 'remote'],
      estimatedMemoryMiB: 24 * 1024,
      measurement: 'upstream',
      notes: 'Upstream describes multi-hour optimization and recommends 24 GB VRAM; every deployment must pin all diffusion components.',
    },
    privacy: externalPrivacy,
    failurePolicy: failure(4 * 60 * 60 * 1000, 64 * 1024 * 1024),
  },
  {
    providerId: 'sdxl-pixel-art-lcm-research',
    modelId: 'stabilityai/stable-diffusion-xl-base-1.0+nerijs/pixel-art-xl+latent-consistency/lcm-lora-sdxl',
    modelVersion: 'diffusers-0.35.2',
    sourceRevision: 'b71269675ec1b85193107a691dd35c308e46f0a5',
    weightSource: 'https://huggingface.co/nerijs/pixel-art-xl/blob/8bf4a4d9ea283e00a51fafda8e0539f8248ea037/pixel-art-xl.safetensors',
    weightRevision: 'hf:sdxl@462165984030d82259a11f4367a4eed129e94a7b+pixel-art-xl@8bf4a4d9ea283e00a51fafda8e0539f8248ea037+lcm-lora-sdxl@a18548dd4956b174ec5b0d78d340c8dae0a129cd',
    license: apache,
    weightLicense: {
      spdx: 'LicenseRef-CreativeML-OpenRAIL-M',
      name: 'CreativeML Open RAIL-M with OpenRAIL++ components',
      url: 'https://huggingface.co/nerijs/pixel-art-xl/blob/8bf4a4d9ea283e00a51fafda8e0539f8248ea037/README.md',
    },
    documentationUrl: 'https://huggingface.co/docs/diffusers/v0.35.2/en/api/pipelines/stable_diffusion/stable_diffusion_xl',
    capabilities: ['learned-pixelization', 'generative-proposal'],
    input: {
      minimumWidth: 32,
      minimumHeight: 32,
      maximumWidth: 2048,
      maximumHeight: 2048,
      preferredWidth: 768,
      preferredHeight: 768,
      colorSpace: 'srgb',
    },
    execution: {
      location: 'local-or-remote',
      devices: ['cuda', 'remote'],
      estimatedMemoryMiB: 12 * 1024,
      measurement: 'local',
      notes: 'The RTX 4060 8 GB route downloaded successfully and the 5.14 GB UNet exceeded the current Windows process commit budget during load. Keep this stack for a higher-memory worker.',
    },
    privacy: localPrivacy,
    failurePolicy: failure(30 * 60_000, 96 * 1024 * 1024),
  },
]

for (const manifest of RESEARCH_MODEL_CATALOG) validateModelManifest(manifest)

export function modelManifest(providerId: string): ModelManifest {
  const manifest = MODEL_CATALOG.find((entry) => entry.providerId === providerId)
  if (manifest === undefined) throw new RangeError(`Unknown model provider ${providerId}`)
  return manifest
}
