import type {
  BinaryMask,
  EvidenceProvenance,
  ImageAnalysis,
} from './types.js'

export function resolvedSubjectMask(analysis: ImageAnalysis | undefined): BinaryMask | undefined {
  return analysis?.subjectMaskEvidence?.mask ?? analysis?.subjectMask
}

export function subjectMaskConfidence(analysis: ImageAnalysis | undefined): number {
  if (resolvedSubjectMask(analysis) === undefined) return 0
  const confidence = analysis?.subjectMaskEvidence?.confidence ?? analysis?.confidence ?? 1
  return Math.min(1, Math.max(0, confidence))
}

export function subjectMaskTrust(analysis: ImageAnalysis | undefined): number {
  if (analysis?.subjectMaskEvidence?.userConfirmed === true) return 1
  return subjectMaskConfidence(analysis)
}

export function numericArrayFingerprintSync(values: ArrayLike<number>): string {
  const buffer = new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT)
  const view = new DataView(buffer)
  const float32 = values instanceof Float32Array
  const bytesPerValue = float32 ? Float32Array.BYTES_PER_ELEMENT : Float64Array.BYTES_PER_ELEMENT
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  const mix = (byte: number): void => {
    first = Math.imul(first ^ byte, 0x01000193)
    second = Math.imul(second ^ byte, 0x85ebca6b)
  }
  mix(bytesPerValue)
  for (let index = 0; index < values.length; index += 1) {
    if (float32) view.setFloat32(0, values[index] ?? 0, false)
    else view.setFloat64(0, values[index] ?? 0, false)
    for (let byte = 0; byte < bytesPerValue; byte += 1) {
      mix(view.getUint8(byte))
    }
  }
  view.setUint32(0, values.length, false)
  for (let byte = 0; byte < Uint32Array.BYTES_PER_ELEMENT; byte += 1) {
    mix(view.getUint8(byte))
  }
  return [first, second]
    .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

export function normalizeEvidenceProvenance(
  provenance: readonly EvidenceProvenance[] | undefined,
): readonly EvidenceProvenance[] {
  const normalized = new Map<string, EvidenceProvenance>()
  for (const entry of provenance ?? []) {
    const value: EvidenceProvenance = {
      origin: entry.origin,
      provider: entry.provider.trim(),
      ...(entry.model?.trim() ? { model: entry.model.trim() } : {}),
      ...(entry.version?.trim() ? { version: entry.version.trim() } : {}),
    }
    const key = `${value.origin}\u0000${value.provider}\u0000${value.model ?? ''}\u0000${value.version ?? ''}`
    normalized.set(key, value)
  }
  return [...normalized.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, value]) => value)
}
