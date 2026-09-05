import { normalizeEvidenceProvenance } from '../analysis-evidence.js'
import type { PatternGenerationRequest } from '../types.js'

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

export function stableHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

async function sha256Hex(data: ArrayBufferView): Promise<string> {
  const bytes = new Uint8Array(data.byteLength)
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Text(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value))
}

export async function arrayFingerprint(values: ArrayLike<number> | undefined): Promise<string | undefined> {
  if (values === undefined) return undefined
  const normalized = new ArrayBuffer(values.length * Float64Array.BYTES_PER_ELEMENT)
  const view = new DataView(normalized)
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, values[index] ?? 0, false)
  }
  return sha256Hex(new Uint8Array(normalized))
}

export async function generationFingerprint(
  request: PatternGenerationRequest,
  version: string,
): Promise<string> {
  const sourceBytes = new Uint8Array(
    request.image.data.buffer,
    request.image.data.byteOffset,
    request.image.data.byteLength,
  )
  const analysis = request.analysis
  const semanticRegions = await Promise.all(
    [...(analysis?.semanticRegions ?? [])]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map(async (region) => ({
        id: region.id,
        label: region.label,
        confidence: region.confidence,
        importance: region.importance,
        provenance: normalizeEvidenceProvenance(region.provenance),
        mask: await arrayFingerprint(region.mask.values),
      })),
  )
  const landmarks = [...(analysis?.landmarks ?? [])]
    .sort((first, second) => first.id.localeCompare(second.id))
    .map((landmark) => ({
      ...landmark,
      provenance: normalizeEvidenceProvenance(landmark.provenance),
    }))
  const subjectMaskEvidence = analysis?.subjectMaskEvidence
  const identity = {
    engine: 'baseline',
    version,
    source: {
      width: request.image.width,
      height: request.image.height,
      hash: await sha256Hex(sourceBytes),
    },
    palette: request.palette,
    analysis: analysis === undefined ? undefined : {
      confidence: analysis.confidence,
      imageType: analysis.imageType,
      modelVersions: analysis.modelVersions,
      suggestedCrop: analysis.suggestedCrop,
      suggestedCropConfidence: analysis.suggestedCropConfidence,
      suggestedCropSource: analysis.suggestedCropSource,
      subjectMask: subjectMaskEvidence === undefined
        ? await arrayFingerprint(analysis.subjectMask?.values)
        : undefined,
      subjectMaskEvidence: subjectMaskEvidence === undefined ? undefined : {
        confidence: subjectMaskEvidence.confidence,
        source: subjectMaskEvidence.source,
        revision: subjectMaskEvidence.revision,
        userConfirmed: subjectMaskEvidence.userConfirmed,
        provenance: normalizeEvidenceProvenance(subjectMaskEvidence.provenance),
        mask: await arrayFingerprint(subjectMaskEvidence.mask.values),
      },
      importanceMap: await arrayFingerprint(analysis.importanceMap?.weights),
      semanticRegions,
      landmarks,
      provenance: normalizeEvidenceProvenance(analysis.provenance),
    },
    options: request.options,
  }
  return (await sha256Text(stableSerialize(identity))).slice(0, 32)
}
