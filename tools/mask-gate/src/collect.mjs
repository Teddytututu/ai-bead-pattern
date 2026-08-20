import {
  confirmMaskEditSession,
  createMaskCorrectionDraftFromSession,
} from '@ai-bead-pattern/pattern-core'

import {
  createMaskGateInteractionRecord,
  createMaskGatePreferenceRecord,
} from './record.mjs'
import { loadMaskGateSidecar } from './sidecar.mjs'

function assertIdentity(attempt, sidecar, sample) {
  const metadata = sidecar.metadata
  const expected = {
    protocolVersion: metadata.protocolVersion,
    datasetId: metadata.datasetId,
    manifestFingerprint: metadata.manifestFingerprint,
    imageId: sample.imageId,
    sampleOrder: metadata.sampleOrder,
    sampleOrderSeed: metadata.sampleOrderSeed,
    coreCommit: metadata.commits.core,
    demoCommit: metadata.commits.demo,
    gatewayCommit: metadata.commits.gateway,
    modelConfigurationId: metadata.modelConfigurationId,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (attempt[key] !== value) throw new RangeError(`Attempt ${key} differs from the sidecar`)
  }
}

export async function collectMaskGateRecord({ sample, sidecarPath, attempt }) {
  const sidecar = await loadMaskGateSidecar(sidecarPath)
  if (sidecar.metadata.imageId !== sample.imageId) {
    throw new RangeError('Sidecar imageId must match the selected manifest sample')
  }
  if (sidecar.metadata.sample.category !== sample.category
    || sidecar.metadata.sample.cohort !== sample.cohort) {
    throw new RangeError('Sidecar sample metadata must match the selected manifest sample')
  }
  assertIdentity(attempt, sidecar, sample)
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
  const hasSession = attempt.session !== undefined
  const draft = hasSession
    ? createMaskCorrectionDraftFromSession(sourceEvidence, attempt.session)
    : undefined
  const confirmed = attempt.outcome === 'confirmed'
    ? confirmMaskEditSession(sourceEvidence, attempt.session)
    : undefined
  const interaction = createMaskGateInteractionRecord({
    ...attempt,
    sample,
    sourceEvidence,
    confirmedRevision: confirmed?.revision,
    baseMaskValues: sourceEvidence.mask.values,
    correctedMaskValues: draft?.mask.values,
  })
  const preference = attempt.outcome === 'confirmed'
    ? createMaskGatePreferenceRecord({ ...attempt, sample })
    : undefined
  return { interaction, preference }
}
