import type { ImageAnalysis } from '@ai-bead-pattern/pattern-core'

import { fuseImageAnalyses } from './analysis-fusion.js'
import {
  mapMediaPipeFaceLandmarks,
  selectPrimaryFace,
  type MediaPipeFaceCandidate,
  type PrimaryFaceSelection,
} from './face-landmarks.js'
import {
  mapPortraitSemanticRegions,
  type PortraitSemanticCategories,
} from './portrait-semantics.js'

export interface PortraitAnalysisInput {
  subjectAnalysis: ImageAnalysis
  faces: readonly MediaPipeFaceCandidate[]
  semanticCategories: PortraitSemanticCategories
  width: number
  height: number
  faceModelVersion: string
  semanticModelVersion: string
}

export type PortraitAnalysisResult = PrimaryFaceSelection & { analysis: ImageAnalysis }

export function analyzePortrait(input: PortraitAnalysisInput): PortraitAnalysisResult {
  const selection = selectPrimaryFace(input.faces)
  if (selection.status !== 'primary') {
    return { ...selection, analysis: fuseImageAnalyses([input.subjectAnalysis]) }
  }
  const face = input.faces[selection.primaryFaceIndex]!
  const faceModelVersion = input.faceModelVersion.trim()
  const landmarks = mapMediaPipeFaceLandmarks(face, {
    width: input.width,
    height: input.height,
    modelVersion: faceModelVersion,
  })
  const landmarkAnalysis: ImageAnalysis = {
    landmarks,
    imageType: 'portrait',
    confidence: face.confidence,
    modelVersions: { faceLandmarks: `mediapipe/${faceModelVersion}` },
    provenance: landmarks.flatMap((landmark) => landmark.provenance ?? []),
  }
  const semanticAnalysis = mapPortraitSemanticRegions({
    subjectAnalysis: input.subjectAnalysis,
    width: input.width,
    height: input.height,
    categories: input.semanticCategories,
    modelVersion: input.semanticModelVersion,
  })
  return {
    ...selection,
    analysis: fuseImageAnalyses([input.subjectAnalysis, semanticAnalysis, landmarkAnalysis]),
  }
}
