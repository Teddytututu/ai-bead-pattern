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
  return [...normalized.values()]
}
