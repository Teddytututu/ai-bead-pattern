import { readFile } from 'node:fs/promises'

export const visionGateProtocolVersion = 'vision-gate-v1'
export const visionGateGridSize = 48

export const visionGateChallengeTags = Object.freeze([
  'front-face',
  'light-profile',
  'three-quarter',
  'glasses',
  'bangs',
  'occlusion',
  'low-light',
  'complex-background',
  'small-full-body',
])

const selectionStatuses = new Set(['primary', 'none', 'ambiguous', 'error'])
const landmarkIds = ['left-eye-center', 'right-eye-center', 'mouth-center']
const regionIds = ['face-skin', 'hair', 'clothes']

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function unit(value, name) {
  if (Number.isFinite(value) === false || value < 0 || value > 1) {
    throw new RangeError(`${name} must stay within 0..1`)
  }
  return value
}

function uniqueTexts(value, name) {
  if (Array.isArray(value) === false || value.length === 0) {
    throw new RangeError(`${name} must contain at least one value`)
  }
  const normalized = value.map((entry, index) => text(entry, `${name}[${index}]`))
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError(`${name} must contain unique values`)
  }
  return normalized
}

function point(value, name) {
  const input = object(value, name)
  return { x: unit(input.x, `${name}.x`), y: unit(input.y, `${name}.y`) }
}

function regionCells(value, name, gridSize) {
  const input = object(value, name)
  if (Array.isArray(input.cells) === false || input.cells.length === 0) {
    throw new RangeError(`${name}.cells must contain at least one grid cell`)
  }
  const cells = input.cells.map((cell, index) =>
    integer(cell, `${name}.cells[${index}]`, 0))
  if (cells.some((cell) => cell >= gridSize * gridSize)) {
    throw new RangeError(`${name}.cells must stay inside the evaluation grid`)
  }
  if (new Set(cells).size !== cells.length) {
    throw new RangeError(`${name}.cells must contain unique values`)
  }
  return { cells: cells.toSorted((first, second) => first - second) }
}

function validateSample(value, index, gridSize) {
  const input = object(value, `samples[${index}]`)
  const annotations = object(input.annotations, `samples[${index}].annotations`)
  const landmarks = object(annotations.landmarks, `samples[${index}].annotations.landmarks`)
  const regions = object(annotations.regions, `samples[${index}].annotations.regions`)
  const challengeTags = uniqueTexts(input.challengeTags, `samples[${index}].challengeTags`)
  for (const tag of challengeTags) {
    if (visionGateChallengeTags.includes(tag) === false) {
      throw new RangeError(`samples[${index}].challengeTags has an unsupported value`)
    }
  }
  return {
    imageId: text(input.imageId, `samples[${index}].imageId`),
    imagePath: text(input.imagePath, `samples[${index}].imagePath`),
    width: integer(input.width, `samples[${index}].width`, 1),
    height: integer(input.height, `samples[${index}].height`, 1),
    challengeTags,
    annotations: {
      landmarks: Object.fromEntries(landmarkIds.map((id) => [
        id,
        point(landmarks[id], `samples[${index}].annotations.landmarks.${id}`),
      ])),
      regions: Object.fromEntries(regionIds.map((id) => [
        id,
        regionCells(regions[id], `samples[${index}].annotations.regions.${id}`, gridSize),
      ])),
    },
  }
}

export function validateVisionGateManifest(value) {
  const input = object(value, 'manifest')
  if (input.schemaVersion !== 1) throw new RangeError('manifest.schemaVersion must equal 1')
  const protocolVersion = text(input.protocolVersion, 'manifest.protocolVersion')
  if (protocolVersion !== visionGateProtocolVersion) {
    throw new RangeError(`manifest.protocolVersion must equal ${visionGateProtocolVersion}`)
  }
  const gridSize = integer(input.gridSize, 'manifest.gridSize', 1)
  if (gridSize !== visionGateGridSize) {
    throw new RangeError(`manifest.gridSize must equal ${visionGateGridSize}`)
  }
  if (Array.isArray(input.samples) === false || input.samples.length !== 30) {
    throw new RangeError('manifest.samples must contain exactly 30 portrait samples')
  }
  const samples = input.samples.map((sample, index) => validateSample(sample, index, gridSize))
  const ids = new Set()
  for (const sample of samples) {
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sample.imageId) === false) {
      throw new RangeError(`imageId ${sample.imageId} must use letters, numbers, underscore, or hyphen`)
    }
    if (ids.has(sample.imageId)) throw new RangeError(`Duplicate imageId: ${sample.imageId}`)
    ids.add(sample.imageId)
  }
  for (const tag of visionGateChallengeTags) {
    if (samples.some((sample) => sample.challengeTags.includes(tag)) === false) {
      throw new RangeError(`manifest.samples must cover challenge tag ${tag}`)
    }
  }
  const commits = object(input.commits, 'manifest.commits')
  return {
    schemaVersion: 1,
    protocolVersion,
    datasetId: text(input.datasetId, 'manifest.datasetId'),
    gridSize,
    modelConfigurationId: text(input.modelConfigurationId, 'manifest.modelConfigurationId'),
    commits: {
      core: text(commits.core, 'manifest.commits.core'),
      gateway: text(commits.gateway, 'manifest.commits.gateway'),
    },
    samples,
  }
}

function predictedLandmark(value, index) {
  const input = object(value, `prediction.landmarks[${index}]`)
  return {
    id: text(input.id, `prediction.landmarks[${index}].id`),
    x: unit(input.x, `prediction.landmarks[${index}].x`),
    y: unit(input.y, `prediction.landmarks[${index}].y`),
    confidence: unit(input.confidence, `prediction.landmarks[${index}].confidence`),
  }
}

function predictedRegion(value, name) {
  const input = object(value, name)
  const width = integer(input.width, `${name}.width`, 1)
  const height = integer(input.height, `${name}.height`, 1)
  if (ArrayBuffer.isView(input.values) === false && Array.isArray(input.values) === false) {
    throw new TypeError(`${name}.values must be a numeric array`)
  }
  if (input.values.length !== width * height) {
    throw new RangeError(`${name}.values length must equal width * height`)
  }
  const values = Float32Array.from(input.values)
  for (const entry of values) unit(entry, `${name}.values`)
  return { width, height, values }
}

export function validateVisionGatePrediction(value) {
  const input = object(value, 'prediction')
  if (input.schemaVersion !== 1) throw new RangeError('prediction.schemaVersion must equal 1')
  const protocolVersion = text(input.protocolVersion, 'prediction.protocolVersion')
  if (protocolVersion !== visionGateProtocolVersion) {
    throw new RangeError(`prediction.protocolVersion must equal ${visionGateProtocolVersion}`)
  }
  const selectionStatus = text(input.selectionStatus, 'prediction.selectionStatus')
  if (selectionStatuses.has(selectionStatus) === false) {
    throw new RangeError('prediction.selectionStatus has an unsupported value')
  }
  if (Array.isArray(input.landmarks) === false) {
    throw new TypeError('prediction.landmarks must be an array')
  }
  const landmarks = input.landmarks.map(predictedLandmark)
  if (new Set(landmarks.map((entry) => entry.id)).size !== landmarks.length) {
    throw new RangeError('prediction.landmarks must contain unique ids')
  }
  const regionsInput = object(input.regions, 'prediction.regions')
  const modelVersionsInput = object(input.modelVersions, 'prediction.modelVersions')
  const modelVersions = Object.fromEntries(Object.entries(modelVersionsInput).map(([key, entry]) => [
    text(key, 'prediction.modelVersions key'),
    text(entry, `prediction.modelVersions.${key}`),
  ]))
  if (Object.keys(modelVersions).length === 0) {
    throw new RangeError('prediction.modelVersions must contain at least one model identity')
  }
  if (selectionStatus !== 'primary'
    && (landmarks.length > 0 || Object.keys(regionsInput).length > 0)) {
    throw new RangeError('prediction non-primary selection must omit portrait outputs')
  }
  return {
    schemaVersion: 1,
    protocolVersion,
    datasetId: text(input.datasetId, 'prediction.datasetId'),
    imageId: text(input.imageId, 'prediction.imageId'),
    selectionStatus,
    landmarks,
    regions: Object.fromEntries(Object.entries(regionsInput).map(([id, entry]) => [
      id,
      predictedRegion(entry, `prediction.regions.${id}`),
    ])),
    modelVersions,
  }
}

function rectangleCells(gridSize, left, top, right, bottom) {
  const cells = []
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) cells.push(y * gridSize + x)
  }
  return cells
}

export function createVisionGateProtocolFixtures() {
  const samples = Array.from({ length: 30 }, (_, index) => {
    const offset = (index % 3) - 1
    return {
      imageId: `portrait-${String(index + 1).padStart(2, '0')}`,
      imagePath: `protocol-fixtures/portrait-${String(index + 1).padStart(2, '0')}.png`,
      width: 480,
      height: 480,
      challengeTags: [
        visionGateChallengeTags[index % visionGateChallengeTags.length],
        visionGateChallengeTags[(index + 4) % visionGateChallengeTags.length],
      ],
      annotations: {
        landmarks: {
          'left-eye-center': { x: (18 + offset) / 48, y: 19 / 48 },
          'right-eye-center': { x: (30 + offset) / 48, y: 19 / 48 },
          'mouth-center': { x: (24 + offset) / 48, y: 30 / 48 },
        },
        regions: {
          'face-skin': { cells: rectangleCells(48, 13 + offset, 10, 36 + offset, 37) },
          hair: { cells: rectangleCells(48, 11 + offset, 7, 38 + offset, 17) },
          clothes: { cells: rectangleCells(48, 9 + offset, 36, 40 + offset, 48) },
        },
      },
    }
  })
  return {
    schemaVersion: 1,
    protocolVersion: visionGateProtocolVersion,
    datasetId: 'vision-gate-protocol-fixtures-30',
    gridSize: visionGateGridSize,
    modelConfigurationId: 'protocol-perfect-predictions-v1',
    commits: { core: 'protocol-fixture', gateway: 'protocol-fixture' },
    samples,
  }
}

function cellsToMask(cells, gridSize) {
  const values = new Float32Array(gridSize * gridSize)
  for (const cell of cells) values[cell] = 1
  return { width: gridSize, height: gridSize, values }
}

export function createVisionGateProtocolPredictions(inputManifest) {
  const manifest = validateVisionGateManifest(inputManifest)
  return manifest.samples.map((sample) => ({
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    datasetId: manifest.datasetId,
    imageId: sample.imageId,
    selectionStatus: 'primary',
    landmarks: landmarkIds.map((id) => ({
      id,
      ...sample.annotations.landmarks[id],
      confidence: 0.98,
    })),
    regions: Object.fromEntries(regionIds.map((id) => [
      id,
      cellsToMask(sample.annotations.regions[id].cells, manifest.gridSize),
    ])),
    modelVersions: {
      faceLandmarks: 'protocol/perfect-v1',
      portraitSemantics: 'protocol/perfect-v1',
    },
  }))
}

export async function loadVisionGateManifest(path) {
  return validateVisionGateManifest(JSON.parse(await readFile(path, 'utf8')))
}

export async function loadVisionGatePredictions(path) {
  const source = await readFile(path, 'utf8')
  const records = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    try {
      records.push(validateVisionGatePrediction(JSON.parse(line)))
    } catch (error) {
      throw new Error(`Invalid Vision Gate prediction at line ${index + 1}: ${error.message}`)
    }
  }
  if (records.length === 0) throw new RangeError('Vision Gate predictions contain zero records')
  return records
}
