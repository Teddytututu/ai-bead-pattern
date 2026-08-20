import {
  confirmMaskEditSession,
  createMaskCorrectionDraftFromSession,
} from '@ai-bead-pattern/pattern-core'

import { createMaskGateRecord } from './record.mjs'
import { loadMaskGateSidecar } from './sidecar.mjs'

export async function collectMaskGateRecord({ sample, datasetId, sidecarPath, attempt }) {
  const sidecar = await loadMaskGateSidecar(sidecarPath)
  if (sidecar.metadata.imageId !== sample.imageId) {
    throw new RangeError('Sidecar imageId must match the selected manifest sample')
  }
  if (sidecar.metadata.datasetId !== datasetId) {
    throw new RangeError('Sidecar datasetId must match the selected manifest')
  }
  const sourceEvidence = {
    mask: sidecar.mask,
    confidence: sidecar.metadata.evidence.confidence,
    source: sidecar.metadata.evidence.source,
    revision: sidecar.metadata.evidence.revision,
    ...(sidecar.metadata.evidence.userConfirmed === undefined
      ? {}
      : { userConfirmed: sidecar.metadata.evidence.userConfirmed }),
    ...(sidecar.metadata.evidence.provenance === undefined
      ? {}
      : { provenance: sidecar.metadata.evidence.provenance }),
  }
  const draft = createMaskCorrectionDraftFromSession(sourceEvidence, attempt.session)
  const confirmed = attempt.outcome === 'confirmed'
    ? confirmMaskEditSession(sourceEvidence, attempt.session)
    : undefined

  return createMaskGateRecord({
    sample,
    datasetId,
    sourceEvidence,
    session: attempt.session,
    confirmedRevision: confirmed?.revision,
    correctionStartedAt: attempt.correctionStartedAt,
    correctionEndedAt: attempt.correctionEndedAt,
    beforeGenerationId: attempt.beforeGenerationId,
    afterGenerationId: attempt.afterGenerationId,
    initialSubjectAcceptable: attempt.initialSubjectAcceptable,
    subjectAcceptable: attempt.subjectAcceptable,
    patternPreference: attempt.patternPreference,
    deviceClass: attempt.deviceClass,
    outcome: attempt.outcome,
    baseMaskValues: sourceEvidence.mask.values,
    correctedMaskValues: draft.mask.values,
  })
}
