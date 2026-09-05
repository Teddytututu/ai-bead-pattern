import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('workbench product controls', () => {
  it('keeps preference annotation as an internal tool while exposing product controls', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /id="refinementModeControl"/)
    assert.match(html, /id="gridRefinementEnergy"/)
    assert.match(html, /id="structureRegionCount"/)
    assert.match(html, /id="valueRoleCount"/)
    assert.match(html, /id="paletteRoleCount"/)
    assert.match(html, /id="clusterFragmentChange"/)
    assert.match(html, /id="smallComponentChange"/)
    assert.match(html, /id="singleCellBandChange"/)
    assert.match(html, /elements\.structureRegionCount\.textContent = candidate\.structurePlan === undefined/)
    assert.match(html, /id="preferencePanel"/)
    assert.match(html, /id="preferencePanel"[^>]*hidden/)
    assert.match(html, /internalToolsEnabled/)
    assert.match(html, /id="preferenceWorkbenchDialog"/)
    assert.match(html, /id="preferenceCandidateGrid"/)
    assert.match(html, /id="preferenceLayerControl"/)
    assert.match(html, /data-preference-layer="features"/)
    assert.match(html, /data-preference-layer="structure"/)
    assert.match(html, /data-preference-layer="value"/)
    assert.match(html, /data-preference-layer="refinement"/)
    assert.match(html, /id="preferenceAxisScores"/)
    assert.match(html, /id="preferenceIssueTags"/)
    assert.match(html, /id="preferenceUndoButton"/)
    assert.match(html, /id="preferenceRedoButton"/)
    assert.match(html, /id="preferenceProgress"/)
    assert.match(html, /id="preferenceExportJsonButton"/)
    assert.match(html, /id="preferenceExportJsonlButton"/)
    assert.match(html, /id="preferenceLearningPanel"/)
    assert.match(html, /id="preferenceLearningSampleCount"/)
    assert.match(html, /id="preferenceHoldoutComparison"/)
    assert.match(html, /id="preferenceRankingDifference"/)
    assert.match(html, /id="preferenceActivePair"/)
    assert.match(html, /id="preferenceGenerationFeedback"/)
    assert.match(html, /preferenceRuntime\.applyGenerationOptions/)
    assert.match(html, /preference-workbench-ui\.mjs/)
    assert.match(html, /preference-runtime\.mjs/)
    assert.match(html, /id="modelRouteSelect"/)
    assert.match(html, /id="modelRouteStatus"/)
    assert.match(html, /selectLearnedProposal/)
    assert.match(html, /学习像素化/)
    assert.match(html, /inferSubjectAnalysis\(learnedProposal\.image\)/)
    assert.match(html, /Pixel Art LCM/)
    assert.match(html, /ai-runtime\.mjs/)
    assert.match(html, /data-analysis-layer="edges"/)
    assert.match(html, /data-analysis-layer="depth"/)
    assert.match(html, /data-analysis-layer="embedding"/)
    assert.match(html, /id="analysisDebugProvider"/)
    assert.match(html, /id="analysisDebugContributions"/)
    assert.match(html, /data-mask-mode="select"/)
    assert.match(html, /圈选主体/)
  })

  it('fits rectangular uploads into square previews with their aspect ratio intact', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /Math\.min\(canvas\.width \/ buffer\.width, canvas\.height \/ buffer\.height\)/)
    assert.match(html, /\(canvas\.width - width\) \/ 2/)
    assert.match(html, /\(canvas\.height - height\) \/ 2/)
  })

  it('projects source evidence through the learned proposal contain frame before generation', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /projectSourceAnalysisToProposal/)
    assert.match(html, /projectSourceAnalysisToProposal\(\s*sourceAnalysis,\s*learnedProposal\s*\)/)
    assert.match(html, /analysis:\s*proposalAnalysis/)
  })

  it('scores every generated candidate with DINOv2 and OpenCLIP before rendering the ranking', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /runAiRoute\([\s\S]*?'preference-scoring'/)
    assert.match(html, /referenceImage:\s*sourceImage/)
    assert.match(html, /dinov2-vits14-pair-local/)
    assert.match(html, /openclip-vit-b32-pair-local/)
    assert.match(html, /composeCandidateEvaluationV2\(\{[\s\S]*?neuralPreferenceFeatures:[\s\S]*?providerContributions:/)
    assert.match(html, /finalRankedCandidateIds[\s\S]*?candidates/)
    assert.match(html, /analysisDebugViewer\.update\(\{[\s\S]*?contributions:[\s\S]*?providerContributions/)
  })

  it('starts busy until the bundled sample finishes its first generation', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /id="status" data-state="busy"/)
    assert.match(html, /id="generateButton" type="button" disabled/)
    assert.match(html, /id="stage" data-busy="true"/)
  })
})
