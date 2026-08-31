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

function luminance(data, index) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722
}

function edgeStrength(image, x, y) {
  const { width, height, data } = image
  const at = (sampleX, sampleY) => {
    const sx = Math.min(width - 1, Math.max(0, sampleX))
    const sy = Math.min(height - 1, Math.max(0, sampleY))
    return luminance(data, (sy * width + sx) * 4)
  }
  const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
    - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
  const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
    - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
  return Math.min(1, Math.hypot(gx, gy) / 1_020)
}

export function snapStrokeToBoundary(points, image, options = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return { points: [], snappedCount: 0, meanDistance: 0, confidence: 0 }
  }
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || !(image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Snap image must contain RGBA pixels aligned to its dimensions')
  }
  const maxDistanceNormalized = Math.min(0.25, Math.max(0.005, options.maxDistanceNormalized ?? 0.06))
  const endpointLock = Math.min(0.25, Math.max(0, options.endpointLock ?? 0.015))
  const maxDistance = Math.min(
    maxDistanceNormalized * Math.min(image.width, image.height),
    12,
  )
  const output = points.map((point) => ({ x: point.x, y: point.y }))
  let snappedCount = 0
  let totalDistance = 0
  let totalConfidence = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const endpoint = index === 0 || index === points.length - 1
    if (endpoint && endpointLock > 0) {
      totalConfidence += 0.8
      continue
    }
    const sourceX = point.x * Math.max(0, image.width - 1)
    const sourceY = point.y * Math.max(0, image.height - 1)
    const radius = Math.max(1, Math.ceil(maxDistance))
    let best
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const distance = Math.hypot(offsetX, offsetY)
        if (distance > maxDistance) continue
        const x = Math.min(image.width - 1, Math.max(0, Math.round(sourceX + offsetX)))
        const y = Math.min(image.height - 1, Math.max(0, Math.round(sourceY + offsetY)))
        const edge = edgeStrength(image, x, y)
        const score = edge - distance / Math.max(1, maxDistance) * 0.28
        if (best === undefined || score > best.score) best = { x, y, score, edge, distance }
      }
    }
    if (best === undefined || best.edge < 0.08) {
      totalConfidence += best?.edge ?? 0
      continue
    }
    output[index] = {
      x: best.x / Math.max(1, image.width - 1),
      y: best.y / Math.max(1, image.height - 1),
    }
    snappedCount += 1
    totalDistance += best.distance / Math.max(1, Math.min(image.width, image.height))
    totalConfidence += Math.min(1, best.edge * 1.8)
  }
  return {
    points: output,
    snappedCount,
    meanDistance: snappedCount === 0 ? 0 : totalDistance / snappedCount,
    confidence: totalConfidence / points.length,
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
      writePixel(overlay, index, [23, 126, 255], 224 * added)
    } else if (erased > 0.01) {
      writePixel(overlay, index, [236, 54, 63], 224 * erased)
    } else if (base > 0.01) {
      writePixel(overlay, index, [24, 169, 133], 148 * base)
    }
  }
  return overlay
}

function samePoint(first, second) {
  return first.x === second.x && first.y === second.y
}

function sameStroke(first, second) {
  return first.id === second.id
    && first.mode === second.mode
    && first.radiusNormalized === second.radiusNormalized
    && first.points.length === second.points.length
    && first.points.every((point, index) => samePoint(point, second.points[index]))
}

export function maskEditSessionIsDirty(session, confirmedSession) {
  if (session === undefined || confirmedSession === undefined) return false
  return session.baseRevision !== confirmedSession.baseRevision
    || session.cursor !== confirmedSession.cursor
    || session.strokes.length !== confirmedSession.strokes.length
    || session.strokes.some((stroke, index) => sameStroke(stroke, confirmedSession.strokes[index]) === false)
}

export function createLiveStrokePreview(canvas) {
  let renderedPointCount = 0

  return {
    reset() {
      renderedPointCount = 0
    },
    draw(points, mode, radiusNormalized) {
      if (points.length === 0) return
      const context = canvas.getContext('2d')
      const shortEdge = Math.min(canvas.width, canvas.height)
      const radius = Math.max(0.5, radiusNormalized * shortEdge)
      const color = mode === 'erase'
        ? 'rgba(255, 74, 82, 0.9)'
        : 'rgba(255, 206, 64, 0.94)'
      const pointAt = (index) => ({
        x: points[index].x * canvas.width,
        y: points[index].y * canvas.height,
      })

      if (renderedPointCount === 0) {
        const point = pointAt(0)
        context.beginPath()
        context.fillStyle = color
        context.arc(point.x, point.y, radius, 0, Math.PI * 2)
        context.fill()
      }

      const startIndex = renderedPointCount === 0
        ? 0
        : Math.max(0, renderedPointCount - 1)
      if (points.length > startIndex + 1) {
        const start = pointAt(startIndex)
        context.beginPath()
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.lineWidth = radius * 2
        context.strokeStyle = color
        context.moveTo(start.x, start.y)
        for (let index = startIndex + 1; index < points.length; index += 1) {
          const point = pointAt(index)
          context.lineTo(point.x, point.y)
        }
        context.stroke()
      }
      renderedPointCount = points.length
    },
  }
}

export function createMaskEditorController({ elements, core, onConfirm, onClose, onFirstPointer }) {
  let sourceImage
  let baseEvidence
  let session
  let confirmedSession
  let draft
  let mode = 'add'
  let radiusNormalized = 0.02
  let pointerId
  let pointerPoints = []
  let strokeSequence = 1
  let previewFrame
  let closeOutcome
  let firstPointerType
  let snapSummary
  const sourceBuffer = document.createElement('canvas')
  const overlayBuffer = document.createElement('canvas')
  const livePreview = createLiveStrokePreview(elements.canvas)

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
    const dirty = maskEditSessionIsDirty(session, confirmedSession)
    elements.undoButton.disabled = session?.cursor === 0
    elements.redoButton.disabled = session === undefined || session.cursor === session.strokes.length
    const snapText = snapSummary === undefined
      ? ''
      : ` · 自动贴边 ${snapSummary.snappedCount} 点`
    elements.detail.textContent = session === undefined
      ? '0 笔'
      : `${session.cursor} / ${session.strokes.length} 笔 · ${dirty ? '待确认，取消将放弃' : '已确认'}${snapText}`
    elements.detail.dataset.dirty = String(dirty)
    elements.dialog.dataset.maskMode = mode
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
      livePreview.draw(pointerPoints, mode, radiusNormalized)
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
    livePreview.reset()
    if (commit) {
      appendPoint(event)
      snapSummary = snapStrokeToBoundary(pointerPoints, sourceImage, {
        maxDistanceNormalized: 0.045,
        endpointLock: 0.02,
      })
      session = core.appendMaskEditStroke(session, {
        ...currentPointerStroke(),
        id: uniqueStrokeId(),
        points: snapSummary.points,
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
    livePreview.reset()
  }

  elements.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || session === undefined) return
    if (firstPointerType === undefined) {
      firstPointerType = event.pointerType || 'mouse'
      onFirstPointer?.(firstPointerType)
    }
    pointerId = event.pointerId
    pointerPoints = []
    livePreview.reset()
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
  elements.dialog.addEventListener('close', () => {
    cancelActivePointer()
    onClose?.({ session, outcome: closeOutcome ?? 'cancelled' })
    closeOutcome = undefined
  })
  elements.confirmButton.addEventListener('click', async () => {
    elements.confirmButton.disabled = true
    try {
      const evidence = core.confirmMaskEditSession(baseEvidence, session)
      confirmedSession = session
      const regeneration = onConfirm({ evidence, session })
      closeOutcome = 'confirmed'
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
      confirmedSession = editSession ?? core.createMaskEditSession(evidence.revision)
      session = confirmedSession
      closeOutcome = 'cancelled'
      firstPointerType = undefined
      snapSummary = undefined
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
