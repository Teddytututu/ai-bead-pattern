import {
  addLocalizedIssue,
  candidateIdentity,
  createPreferenceSession,
  exportPreferenceRecord,
  exportPreferenceSession,
  loadPreferenceSession,
  preferenceAxes,
  preferenceCompletion,
  preferenceIssueTags,
  recordCandidateComparison,
  redoPreferenceEdit,
  savePreferenceSession,
  setCandidateAxisScore,
  setCandidateRanking,
  undoPreferenceEdit,
  updateLocalizedIssue,
} from './preference-workbench.mjs'

const layerLabels = {
  pattern: '图纸',
  grid: '网格',
  features: '关键点',
  structure: '结构区',
  value: '明度区',
  refinement: '精修差异',
}

function downloadText(name, type, value) {
  const link = document.createElement('a')
  link.download = name
  link.href = URL.createObjectURL(new Blob([value], { type }))
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 0)
}

function drawSource(canvas, image) {
  const maximum = 320
  const scale = Math.min(maximum / image.width, maximum / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  canvas.width = maximum
  canvas.height = maximum
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, maximum, maximum)
  const buffer = document.createElement('canvas')
  buffer.width = image.width
  buffer.height = image.height
  buffer.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0,
  )
  context.imageSmoothingEnabled = true
  context.drawImage(buffer, (maximum - width) / 2, (maximum - height) / 2, width, height)
}

function overlayCell(context, canvas, pattern, cell, fill, stroke = fill) {
  const cellSize = Math.min(canvas.width / pattern.width, canvas.height / pattern.height)
  const offsetX = (canvas.width - pattern.width * cellSize) / 2
  const offsetY = (canvas.height - pattern.height * cellSize) / 2
  const x = offsetX + cell.x * cellSize
  const y = offsetY + cell.y * cellSize
  context.fillStyle = fill
  context.fillRect(x, y, cellSize, cellSize)
  context.strokeStyle = stroke
  context.lineWidth = Math.max(1, cellSize * 0.08)
  context.strokeRect(x + 0.5, y + 0.5, Math.max(0, cellSize - 1), Math.max(0, cellSize - 1))
}

function drawOverlay(canvas, candidate, layer, annotations) {
  const context = canvas.getContext('2d')
  if (layer === 'features') {
    for (const placement of candidate.featurePlacements ?? []) {
      for (const cell of placement.occupiedCells) {
        overlayCell(context, canvas, candidate.pattern, {
          x: cell % candidate.pattern.width,
          y: Math.floor(cell / candidate.pattern.width),
        }, 'rgba(225,63,55,.38)', '#b92d28')
      }
    }
  }
  if (layer === 'structure') {
    const hues = ['rgba(37,125,115,.32)', 'rgba(226,180,48,.30)', 'rgba(214,83,77,.28)', 'rgba(39,105,153,.28)']
    for (const region of candidate.structurePlan?.regions ?? []) {
      for (const cell of region.cellIndices) {
        overlayCell(context, canvas, candidate.pattern, {
          x: cell % candidate.pattern.width,
          y: Math.floor(cell / candidate.pattern.width),
        }, hues[region.id % hues.length], 'rgba(20,30,28,.14)')
      }
    }
  }
  if (layer === 'value') {
    const roles = new Map((candidate.valuePlan?.roles ?? []).map((role) => [role.regionId, role.targetLightness]))
    for (const region of candidate.structurePlan?.regions ?? []) {
      const lightness = roles.get(String(region.id)) ?? 50
      const shade = Math.round(lightness / 100 * 255)
      for (const cell of region.cellIndices) {
        overlayCell(context, canvas, candidate.pattern, {
          x: cell % candidate.pattern.width,
          y: Math.floor(cell / candidate.pattern.width),
        }, `rgba(${shade},${shade},${shade},.42)`, 'rgba(20,30,28,.12)')
      }
    }
  }
  if (layer === 'refinement') {
    for (const edit of candidate.edits ?? []) {
      overlayCell(context, canvas, candidate.pattern, edit, 'rgba(227,184,63,.48)', '#8d6b08')
    }
  }
  for (const annotation of annotations) {
    for (const cell of annotation.cells) {
      overlayCell(context, canvas, candidate.pattern, cell, 'rgba(255,255,255,.08)', '#d6534d')
    }
  }
}

function canvasCell(canvas, pattern, event) {
  const bounds = canvas.getBoundingClientRect()
  const scaleX = canvas.width / bounds.width
  const scaleY = canvas.height / bounds.height
  const localX = (event.clientX - bounds.left) * scaleX
  const localY = (event.clientY - bounds.top) * scaleY
  const cellSize = Math.min(canvas.width / pattern.width, canvas.height / pattern.height)
  const offsetX = (canvas.width - pattern.width * cellSize) / 2
  const offsetY = (canvas.height - pattern.height * cellSize) / 2
  const x = Math.floor((localX - offsetX) / cellSize)
  const y = Math.floor((localY - offsetY) / cellSize)
  if (x < 0 || y < 0 || x >= pattern.width || y >= pattern.height) return undefined
  return { x, y }
}

export function createPreferenceWorkbenchController({
  elements,
  drawPattern,
  preferenceRuntime,
  storage = globalThis.localStorage,
}) {
  let session
  let input
  let selectedCandidateId
  let layer = 'grid'
  let selectedTag = 'facial-feature-loss'
  let zoom = 1
  let learningState

  function syncLearning() {
    if (preferenceRuntime === undefined) return
    learningState = preferenceRuntime.ingestSession(session, {
      ruleScores: Object.fromEntries(input.candidates.slice(0, 4)
        .map((candidate) => [candidate.id, candidate.score])),
      neuralPreferenceFeatures: input.evaluationEvidence?.neuralPreferenceFeatures ?? [],
      providerContributions: input.evaluationEvidence?.providerContributions ?? [],
    })
    elements.dialog.dataset.preferenceRecordSchema = String(learningState.record.schemaVersion)
  }

  function persist() {
    savePreferenceSession(storage, session)
    syncLearning()
  }

  function candidateById(candidateId) {
    return input.candidates.find((candidate) => candidate.id === candidateId)
  }

  function renderSource() {
    drawSource(elements.sourceCanvas, input.image)
    elements.sourceIdentity.textContent = `${input.source.id} · ${input.source.kind} · ${input.image.width}×${input.image.height}`
  }

  function renderLayers() {
    for (const button of elements.layerControl.querySelectorAll('button[data-preference-layer]')) {
      button.setAttribute('aria-pressed', String(button.dataset.preferenceLayer === layer))
    }
  }

  function renderCandidates() {
    elements.candidateGrid.replaceChildren()
    for (const [index, candidateId] of session.candidateOrder.entries()) {
      const candidate = candidateById(candidateId)
      const card = document.createElement('section')
      card.className = 'preference-candidate-card'
      card.dataset.candidateId = candidate.id
      card.dataset.selected = String(candidate.id === selectedCandidateId)
      const header = document.createElement('button')
      header.type = 'button'
      header.className = 'preference-candidate-header'
      header.textContent = `${index + 1}. ${candidate.style} · ${candidate.pattern.width}×${candidate.pattern.height}`
      header.addEventListener('click', () => {
        selectedCandidateId = candidate.id
        render()
      })
      const canvas = document.createElement('canvas')
      canvas.className = 'preference-candidate-canvas'
      canvas.dataset.candidateId = candidate.id
      canvas.setAttribute('aria-label', `${header.textContent} ${layerLabels[layer]}，点击格子添加问题标记`)
      canvas.style.width = `${Math.round(100 * zoom)}%`
      drawPattern(canvas, candidate.pattern, { maximum: 420, grid: layer !== 'pattern' })
      drawOverlay(canvas, candidate, layer,
        session.annotations.filter((annotation) => annotation.candidateId === candidate.id))
      canvas.addEventListener('click', (event) => {
        selectedCandidateId = candidate.id
        const cell = canvasCell(canvas, candidate.pattern, event)
        if (cell === undefined) return
        session = addLocalizedIssue(session, {
          candidateId: candidate.id,
          tag: selectedTag,
          severity: Number(elements.severity.value),
          confidence: Number(elements.confidence.value),
          note: elements.note.value,
          cells: [cell],
        })
        persist()
        render()
      })
      const meta = document.createElement('p')
      meta.className = 'preference-candidate-meta'
      const ruleRank = (learningState?.ruleRanking.indexOf(candidate.id) ?? -1) + 1
      const learnedRank = (learningState?.learnedRanking.indexOf(candidate.id) ?? -1) + 1
      const rankingLabel = ruleRank > 0 && learnedRank > 0 ? ` · 规则#${ruleRank} / 学习#${learnedRank}` : ''
      meta.textContent = `${candidate.proposalSource?.model ?? 'pattern-core'} · ${candidate.pattern.metadata.paletteId} · ${Math.round(candidate.score.total * 100)}分${rankingLabel}`
      card.append(header, canvas, meta)
      elements.candidateGrid.append(card)
    }
  }

  function renderAxes() {
    elements.axisScores.replaceChildren()
    const scores = session.axisScores[selectedCandidateId]
    for (const axis of preferenceAxes) {
      const row = document.createElement('label')
      row.className = 'preference-axis-row'
      const name = document.createElement('span')
      name.textContent = axis.label
      const range = document.createElement('input')
      range.type = 'range'
      range.min = '1'
      range.max = '5'
      range.step = '1'
      range.value = String(scores[axis.id] ?? 3)
      range.dataset.axisId = axis.id
      const output = document.createElement('output')
      output.textContent = scores[axis.id] === null ? '待评' : String(scores[axis.id])
      range.addEventListener('input', () => {
        output.textContent = range.value
      })
      range.addEventListener('change', () => {
        session = setCandidateAxisScore(session, selectedCandidateId, axis.id, Number(range.value))
        persist()
        renderProgress()
      })
      row.append(name, range, output)
      elements.axisScores.append(row)
    }
  }

  function renderTags() {
    elements.issueTags.replaceChildren()
    for (const tag of preferenceIssueTags) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'preference-tag'
      button.dataset.issueTag = tag.id
      button.setAttribute('aria-pressed', String(tag.id === selectedTag))
      button.textContent = tag.label
      button.addEventListener('click', () => {
        selectedTag = tag.id
        renderTags()
      })
      elements.issueTags.append(button)
    }
  }

  function renderIssueList() {
    elements.issueList.replaceChildren()
    const issues = session.annotations.filter((annotation) => annotation.candidateId === selectedCandidateId)
    if (issues.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'preference-empty'
      empty.textContent = '点击候选图纸格子添加问题位置'
      elements.issueList.append(empty)
      return
    }
    for (const issue of issues) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'preference-issue-row'
      const label = preferenceIssueTags.find((tag) => tag.id === issue.tag)?.label ?? issue.tag
      row.textContent = `${label} · ${issue.cells.map((cell) => `${cell.x + 1},${cell.y + 1}`).join(' · ')} · S${issue.severity}`
      row.addEventListener('click', () => {
        const severity = issue.severity === 3 ? 1 : issue.severity + 1
        session = updateLocalizedIssue(session, issue.id, { severity })
        persist()
        render()
      })
      elements.issueList.append(row)
    }
  }

  function renderRanking() {
    elements.bestCandidate.replaceChildren()
    for (const candidateId of session.candidateOrder) {
      const option = document.createElement('option')
      option.value = candidateId
      option.textContent = candidateId
      option.selected = candidateId === session.ranking.bestCandidateId
      elements.bestCandidate.append(option)
    }
    if (session.ranking.bestCandidateId === undefined) elements.bestCandidate.selectedIndex = -1
    elements.composite.replaceChildren()
    for (const candidateId of session.candidateOrder) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = candidateId
      checkbox.checked = session.ranking.compositeCandidateIds.includes(candidateId)
      checkbox.addEventListener('change', updateRanking)
      label.append(checkbox, document.createTextNode(candidateId))
      elements.composite.append(label)
    }
  }

  function updateRanking() {
    const bestCandidateId = elements.bestCandidate.value || undefined
    const compositeCandidateIds = [...elements.composite.querySelectorAll('input:checked')]
      .map((checkbox) => checkbox.value)
    const order = bestCandidateId === undefined
      ? [...session.ranking.order]
      : [bestCandidateId, ...session.ranking.order.filter((id) => id !== bestCandidateId)]
    session = setCandidateRanking(session, {
      ...session.ranking,
      order,
      bestCandidateId,
      compositeCandidateIds,
      updatedAt: Date.now(),
    })
    persist()
    renderProgress()
  }

  function renderProgress() {
    const progress = preferenceCompletion(session)
    elements.progress.value = progress.percent
    elements.progressText.textContent = `${progress.percent}% · ${progress.scored}/${progress.totalScores} 项评分 · ${progress.annotations} 个位置`
    elements.undo.disabled = session.history.length === 0
    elements.redo.disabled = session.future.length === 0
    elements.status.textContent = `${session.annotatorId} · ${session.comparisons.length} 次比较 · ${layerLabels[layer]}`
  }

  function candidateLabel(candidateId) {
    const candidate = candidateById(candidateId)
    return candidate === undefined ? candidateId : `${candidate.style} ${candidate.pattern.width}`
  }

  function renderLearning() {
    if (learningState === undefined) {
      elements.learningStatus.textContent = '等待标注'
      return
    }
    const selection = learningState.selection
    elements.learningStatus.textContent = selection.rolledBack
      ? `基线保持 · 挑战者 ${learningState.challengerModel.version}`
      : `学习版生效 · ${selection.selectedVersion}`
    elements.learningSampleCount.textContent = `${learningState.sampleCount} 条 · 训练 ${learningState.split.recordIds.train.length} · 留出 ${learningState.split.recordIds.holdout.length}`
    const baseline = learningState.comparison.baseline
    const challenger = learningState.comparison.challenger
    elements.holdoutComparison.textContent = `${baseline.comparisons ?? 0} 对 · 准确率 ${Math.round((baseline.accuracy ?? 0) * 100)}% → ${Math.round((challenger.accuracy ?? 0) * 100)}% · LogLoss ${(baseline.logLoss ?? 0).toFixed(3)} → ${(challenger.logLoss ?? 0).toFixed(3)}`
    const rule = learningState.ruleRanking.map(candidateLabel).join(' › ')
    const learned = learningState.learnedRanking.map(candidateLabel).join(' › ')
    elements.rankingDifference.textContent = `规则 ${rule} · 学习 ${learned}`
    elements.activePair.textContent = `${candidateLabel(learningState.activePair.candidateAId)} ↔ ${candidateLabel(learningState.activePair.candidateBId)} · 优先级 ${learningState.activePair.priority.toFixed(2)}`
    const parameters = learningState.generationParameters
    elements.generationFeedback.textContent = `特征 ${parameters.importanceStrength.toFixed(2)} · 边缘 ${parameters.edgeProtection.toFixed(2)} · 精修 ${parameters.localSearchIterations} · 色数 ×${parameters.maxColorsScale.toFixed(2)}`
    elements.learnedWeights.textContent = learningState.weightEntries.slice(0, 5)
      .map(([name, value]) => `${name} ${value.toFixed(3)}`).join(' · ')
  }

  function render() {
    renderSource()
    renderLayers()
    renderCandidates()
    renderAxes()
    renderTags()
    renderIssueList()
    renderRanking()
    renderProgress()
    renderLearning()
  }

  function compare(choice) {
    const selectedIndex = session.candidateOrder.indexOf(selectedCandidateId)
    const firstId = learningState?.activePair.candidateAId ?? selectedCandidateId
    const secondId = learningState?.activePair.candidateBId
      ?? session.candidateOrder[(selectedIndex + 1) % session.candidateOrder.length]
    selectedCandidateId = firstId
    session = recordCandidateComparison(session, {
      candidateIds: [firstId, secondId],
      choice,
      strengths: choice === 'first' ? [firstId]
        : choice === 'second' ? [secondId]
          : choice === 'composite' ? [firstId, secondId] : [],
    })
    if (choice === 'first' || choice === 'second') {
      const bestCandidateId = choice === 'first' ? firstId : secondId
      session = setCandidateRanking(session, {
        ...session.ranking,
        order: [bestCandidateId, ...session.ranking.order.filter((id) => id !== bestCandidateId)],
        bestCandidateId,
        updatedAt: Date.now(),
      })
    }
    persist()
    render()
  }

  function open(nextInput) {
    input = nextInput
    const restored = loadPreferenceSession(storage, nextInput.generationId)
    session = restored ?? createPreferenceSession({
      generationId: nextInput.generationId,
      source: nextInput.source,
      annotatorId: nextInput.annotatorId,
      candidates: nextInput.candidates.slice(0, 4).map(candidateIdentity),
    })
    selectedCandidateId = session.ranking.bestCandidateId ?? session.candidateOrder[0]
    syncLearning()
    elements.dialog.showModal()
    render()
    elements.close.focus()
  }

  elements.close.addEventListener('click', () => elements.dialog.close())
  elements.layerControl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-preference-layer]')
    if (button === null) return
    layer = button.dataset.preferenceLayer
    render()
  })
  elements.undo.addEventListener('click', () => {
    session = undoPreferenceEdit(session)
    persist()
    render()
  })
  elements.redo.addEventListener('click', () => {
    session = redoPreferenceEdit(session)
    persist()
    render()
  })
  elements.bestCandidate.addEventListener('change', updateRanking)
  elements.compare.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-comparison-choice]')
    if (button !== null) compare(button.dataset.comparisonChoice)
  })
  elements.exportJson.addEventListener('click', () => downloadText(
    `preference-${session.generationId}.json`,
    'application/json',
    preferenceRuntime === undefined
      ? exportPreferenceSession(session, 'json')
      : exportPreferenceRecord(session, preferenceRuntime.recordFromSession, 'json'),
  ))
  elements.exportJsonl.addEventListener('click', () => downloadText(
    `preference-${session.generationId}.jsonl`,
    'application/x-ndjson',
    preferenceRuntime === undefined
      ? exportPreferenceSession(session, 'jsonl')
      : exportPreferenceRecord(session, preferenceRuntime.recordFromSession, 'jsonl'),
  ))
  elements.trainReplay?.addEventListener('click', () => {
    syncLearning()
    render()
  })
  elements.zoom.addEventListener('input', () => {
    zoom = Number(elements.zoom.value)
    renderCandidates()
  })
  elements.dialog.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      elements.undo.click()
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      elements.redo.click()
      return
    }
    const candidateIndex = Number(event.key) - 1
    if (candidateIndex >= 0 && candidateIndex < session.candidateOrder.length) {
      selectedCandidateId = session.candidateOrder[candidateIndex]
      render()
    }
    if (event.key === 'a') compare('first')
    if (event.key === 'b') compare('second')
    if (event.key === 't') compare('tie')
  })

  return { open, getSession: () => session, getLearningState: () => learningState }
}
