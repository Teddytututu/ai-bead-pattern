import {
  normalizeEvidenceProvenance,
  type EvidenceProvenance,
  type ImageAnalysis,
  type ImageLandmark,
  type SemanticRegion,
  type SubjectMaskEvidence,
} from '@ai-bead-pattern/pattern-core'

function maskPriority(evidence: SubjectMaskEvidence): readonly [number, number, number] {
  return [
    evidence.userConfirmed === true ? 1 : 0,
    evidence.confidence,
    evidence.source === 'manual' || evidence.source === 'ai+manual' ? 1 : 0,
  ]
}

function comparePriority(first: SubjectMaskEvidence, second: SubjectMaskEvidence): number {
  const left = maskPriority(first)
  const right = maskPriority(second)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return 0
}

function selectedSubjectMask(analyses: readonly ImageAnalysis[]): SubjectMaskEvidence | undefined {
  const evidence: SubjectMaskEvidence[] = []
  analyses.forEach((analysis, index) => {
    if (analysis.subjectMaskEvidence !== undefined) {
      evidence.push(analysis.subjectMaskEvidence)
      return
    }
    if (analysis.subjectMask === undefined) return
    evidence.push({
      mask: analysis.subjectMask,
      confidence: analysis.confidence ?? 1,
      source: 'ai',
      revision: `legacy-analysis-${index}`,
      ...(analysis.provenance === undefined ? {} : { provenance: analysis.provenance }),
    })
  })
  return evidence.reduce<SubjectMaskEvidence | undefined>((selected, candidate) =>
    selected === undefined || comparePriority(candidate, selected) > 0 ? candidate : selected,
  undefined)
}

function mergeById<T extends { id: string; confidence: number }>(
  groups: readonly (readonly T[] | undefined)[],
): readonly T[] {
  const selected = new Map<string, T>()
  for (const group of groups) {
    for (const candidate of group ?? []) {
      const current = selected.get(candidate.id)
      if (current === undefined || candidate.confidence > current.confidence) {
        selected.set(candidate.id, candidate)
      }
    }
  }
  return [...selected.values()]
}

function evidenceConfidence(
  subject: SubjectMaskEvidence | undefined,
  landmarks: readonly ImageLandmark[],
  regions: readonly SemanticRegion[],
  analyses: readonly ImageAnalysis[],
): number | undefined {
  const values = [
    ...(subject === undefined ? [] : [subject.confidence]),
    ...landmarks.map((landmark) => landmark.confidence),
    ...regions.map((region) => region.confidence),
  ]
  if (values.length === 0) {
    values.push(...analyses.flatMap((analysis) =>
      analysis.confidence === undefined ? [] : [analysis.confidence],
    ))
  }
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function collectedProvenance(
  analyses: readonly ImageAnalysis[],
  subject: SubjectMaskEvidence | undefined,
  landmarks: readonly ImageLandmark[],
  regions: readonly SemanticRegion[],
): readonly EvidenceProvenance[] {
  return normalizeEvidenceProvenance([
    ...(subject?.provenance ?? []),
    ...landmarks.flatMap((landmark) => landmark.provenance ?? []),
    ...regions.flatMap((region) => region.provenance ?? []),
    ...analyses.flatMap((analysis) => analysis.provenance ?? []),
  ])
}

export function fuseImageAnalyses(analyses: readonly ImageAnalysis[]): ImageAnalysis {
  const subject = selectedSubjectMask(analyses)
  const landmarks = mergeById(analyses.map((analysis) => analysis.landmarks))
  const semanticRegions = mergeById(analyses.map((analysis) => analysis.semanticRegions))
  const manualCrop = [...analyses].reverse().find((analysis) =>
    analysis.suggestedCrop !== undefined && analysis.suggestedCropSource === 'manual',
  )
  const automaticCrop = analyses.reduce<ImageAnalysis | undefined>((selected, analysis) => {
    if (analysis.suggestedCrop === undefined) return selected
    if (selected === undefined
      || (analysis.suggestedCropConfidence ?? 0) > (selected.suggestedCropConfidence ?? 0)) {
      return analysis
    }
    return selected
  }, undefined)
  const cropSource = manualCrop ?? automaticCrop
  const importanceSource = [...analyses].reverse().find((analysis) => analysis.importanceMap !== undefined)
  const imageTypeSource = [...analyses].reverse().find((analysis) => analysis.imageType !== undefined)
  const modelVersions = Object.assign({}, ...analyses.map((analysis) => analysis.modelVersions ?? {}))
  const provenance = collectedProvenance(analyses, subject, landmarks, semanticRegions)
  const confidence = evidenceConfidence(subject, landmarks, semanticRegions, analyses)

  return {
    ...(subject === undefined ? {} : { subjectMaskEvidence: subject, subjectMask: subject.mask }),
    ...(semanticRegions.length === 0 ? {} : { semanticRegions }),
    ...(landmarks.length === 0 ? {} : { landmarks }),
    ...(importanceSource?.importanceMap === undefined ? {} : { importanceMap: importanceSource.importanceMap }),
    ...(cropSource?.suggestedCrop === undefined ? {} : {
      suggestedCrop: cropSource.suggestedCrop,
      suggestedCropConfidence: cropSource.suggestedCropConfidence,
      suggestedCropSource: cropSource.suggestedCropSource,
    }),
    ...(imageTypeSource?.imageType === undefined ? {} : { imageType: imageTypeSource.imageType }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(Object.keys(modelVersions).length === 0 ? {} : { modelVersions }),
    ...(provenance.length === 0 ? {} : { provenance }),
  }
}
