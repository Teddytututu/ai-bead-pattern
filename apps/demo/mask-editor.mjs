function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`)
  }
}

export function fitContainRect(sourceWidth, sourceHeight, viewportWidth, viewportHeight) {
  positive(sourceWidth, 'sourceWidth')
  positive(sourceHeight, 'sourceHeight')
  positive(viewportWidth, 'viewportWidth')
  positive(viewportHeight, 'viewportHeight')
  const scale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (viewportWidth - width) / 2,
    y: (viewportHeight - height) / 2,
    width,
    height,
    scale,
  }
}

export function normalizePointerPoint(clientX, clientY, rect) {
  positive(rect?.width, 'rect.width')
  positive(rect?.height, 'rect.height')
  const clamp = (value) => Math.min(1, Math.max(0, value))
  return {
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  }
}

function writePixel(target, index, color, alpha) {
  const offset = index * 4
  target[offset] = color[0]
  target[offset + 1] = color[1]
  target[offset + 2] = color[2]
  target[offset + 3] = Math.round(alpha)
}

export function composeMaskOverlay(baseValues, currentValues) {
  if (baseValues?.length !== currentValues?.length) {
    throw new RangeError('Mask overlay buffers must have the same length')
  }
  const overlay = new Uint8ClampedArray(baseValues.length * 4)
  for (let index = 0; index < baseValues.length; index += 1) {
    const base = Math.min(1, Math.max(0, baseValues[index] ?? 0))
    const current = Math.min(1, Math.max(0, currentValues[index] ?? 0))
    const added = Math.max(0, current - base)
    const erased = Math.max(0, base - current)
    if (added > 0.01) {
      writePixel(overlay, index, [36, 112, 185], 168 * added)
    } else if (erased > 0.01) {
      writePixel(overlay, index, [214, 83, 77], 168 * erased)
    } else if (base > 0.01) {
      writePixel(overlay, index, [40, 125, 115], 92 * base)
    }
  }
  return overlay
}

export function createMaskEditorController({ elements, core, onConfirm }) {
  let sourceImage
  let baseEvidence
  let session
  let draft
  let mode = 'add'
  let radiusNormalized = 0.02
  let pointerId
  let pointerPoints = []
  let strokeSequence = 1
  let previewFrame
  const sourceBuffer = document.createElement('canvas')
  const overlayBuffer = document.createElement('canvas')

  function resizeCanvasDisplay() {
    if (sourceImage === undefined || elements.dialog.open === false) return
    const viewport = elements.canvas.parentElement?.getBoundingClientRect()
    if (viewport === undefined || viewport.width <= 0 || viewport.height <= 0) return
    const fit = fitContainRect(
      sourceImage.width,
      sourceImage.height,
      viewport.width,
      viewport.height,
    )
    elements.canvas.style.width = `${Math.max(1, fit.width)}px`
    elements.canvas.style.height = `${Math.max(1, fit.height)}px`
  }

  function prepareImageBuffers() {
    const canvas = elements.canvas
    canvas.width = sourceImage.width
    canvas.height = sourceImage.height
    sourceBuffer.width = sourceImage.width
    sourceBuffer.height = sourceImage.height
    overlayBuffer.width = sourceImage.width
    overlayBuffer.height = sourceImage.height
    sourceBuffer.getContext('2d').putImageData(new ImageData(
      new Uint8ClampedArray(sourceImage.data),
      sourceImage.width,
      sourceImage.height,
    ), 0, 0)
  }

  function setPressed(container, attribute, value) {
    for (const button of container.querySelectorAll(`button[${attribute}]`)) {
      button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === String(value)))
    }
  }

  function syncControls() {
    elements.undoButton.disabled = session?.cursor === 0
    elements.redoButton.disabled = session === undefined || session.cursor === session.strokes.length
    elements.detail.textContent = session === undefined
      ? '0 笔'
      : `${session.cursor} / ${session.strokes.length} 笔`
    setPressed(elements.modeControl, 'data-mask-mode', mode)
    setPressed(elements.radiusControl, 'data-mask-radius', radiusNormalized)
  }

  function drawMask(mask) {
    const canvas = elements.canvas
    if (sourceImage === undefined || baseEvidence === undefined) return
    const overlay = composeMaskOverlay(baseEvidence.mask.values, mask.values)
    overlayBuffer.getContext('2d').putImageData(new ImageData(
      overlay,
      sourceImage.width,
      sourceImage.height,
    ), 0, 0)
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(sourceBuffer, 0, 0)
    context.drawImage(overlayBuffer, 0, 0)
  }

  function rebuildDraft() {
    draft = core.createMaskCorrectionDraftFromSession(baseEvidence, session)
    drawMask(draft.mask)
    syncControls()
  }

  function uniqueStrokeId() {
    let id
    do {
      id = `editor-${strokeSequence}`
      strokeSequence += 1
    } while (session.strokes.some((stroke) => stroke.id === id))
    return id
  }

  function currentPointerStroke() {
    return {
      id: 'editor-preview',
      mode,
      points: pointerPoints,
      radiusNormalized,
    }
  }

  function schedulePreview() {
    if (previewFrame !== undefined || pointerPoints.length === 0) return
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined
      drawMask(core.applyMaskStrokes(draft.mask, [currentPointerStroke()]))
    })
  }

  function appendPoint(event) {
    const point = normalizePointerPoint(
      event.clientX,
      event.clientY,
      elements.canvas.getBoundingClientRect(),
    )
    const previous = pointerPoints.at(-1)
    if (previous === undefined || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.001) {
      pointerPoints.push(point)
    }
  }

  function finishPointer(event, commit) {
    if (pointerId !== event.pointerId) return
    if (previewFrame !== undefined) {
      cancelAnimationFrame(previewFrame)
      previewFrame = undefined
    }
    if (elements.canvas.hasPointerCapture(pointerId)) elements.canvas.releasePointerCapture(pointerId)
    if (commit) {
      appendPoint(event)
      session = core.appendMaskEditStroke(session, {
        ...currentPointerStroke(),
        id: uniqueStrokeId(),
      })
      rebuildDraft()
    } else {
      drawMask(draft.mask)
    }
    pointerId = undefined
    pointerPoints = []
  }

  function cancelActivePointer() {
    if (previewFrame !== undefined) {
      cancelAnimationFrame(previewFrame)
      previewFrame = undefined
    }
    if (pointerId !== undefined && elements.canvas.hasPointerCapture(pointerId)) {
      elements.canvas.releasePointerCapture(pointerId)
    }
    pointerId = undefined
    pointerPoints = []
  }

  elements.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || session === undefined) return
    pointerId = event.pointerId
    pointerPoints = []
    elements.canvas.setPointerCapture(pointerId)
    appendPoint(event)
    schedulePreview()
  })
  elements.canvas.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return
    appendPoint(event)
    schedulePreview()
  })
  elements.canvas.addEventListener('pointerup', (event) => finishPointer(event, true))
  elements.canvas.addEventListener('pointercancel', (event) => finishPointer(event, false))
  elements.modeControl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mask-mode]')
    if (button === null) return
    mode = button.dataset.maskMode
    syncControls()
  })
  elements.radiusControl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mask-radius]')
    if (button === null) return
    radiusNormalized = Number(button.dataset.maskRadius)
    syncControls()
  })
  elements.undoButton.addEventListener('click', () => {
    session = core.undoMaskEdit(session)
    rebuildDraft()
  })
  elements.redoButton.addEventListener('click', () => {
    session = core.redoMaskEdit(session)
    rebuildDraft()
  })
  elements.resetButton.addEventListener('click', () => {
    session = core.createMaskEditSession(baseEvidence.revision)
    rebuildDraft()
  })
  elements.closeButton.addEventListener('click', () => elements.dialog.close())
  elements.dialog.addEventListener('close', cancelActivePointer)
  elements.confirmButton.addEventListener('click', async () => {
    elements.confirmButton.disabled = true
    try {
      const evidence = core.confirmMaskEditSession(baseEvidence, session)
      const regeneration = onConfirm({ evidence, session })
      elements.dialog.close()
      await regeneration
    } finally {
      elements.confirmButton.disabled = false
    }
  })

  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? undefined
    : new ResizeObserver(resizeCanvasDisplay)
  resizeObserver?.observe(elements.canvas.parentElement)

  return {
    open({ image, evidence, editSession }) {
      sourceImage = image
      baseEvidence = evidence
      session = editSession ?? core.createMaskEditSession(evidence.revision)
      strokeSequence = session.strokes.length + 1
      prepareImageBuffers()
      elements.dialog.showModal()
      resizeCanvasDisplay()
      rebuildDraft()
      elements.canvas.focus()
    },
    close() {
      if (elements.dialog.open) elements.dialog.close()
    },
  }
}
