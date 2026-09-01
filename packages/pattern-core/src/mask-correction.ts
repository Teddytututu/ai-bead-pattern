import {
  normalizeEvidenceProvenance,
  numericArrayFingerprintSync,
} from './analysis-evidence.js'
import type {
  BinaryMask,
  EvidenceProvenance,
  SubjectMaskEvidence,
  SubjectMaskSource,
} from './types.js'

const MAX_MASK_SIDE = 2048
const MAX_STROKES = 512
const MAX_POINTS_PER_STROKE = 8192
const MAX_TOTAL_POINTS = 32768
const MAX_INTERPOLATED_SAMPLES = 2_000_000
const EVIDENCE_ORIGINS = ['model', 'source', 'heuristic', 'manual', 'fused'] as const
const SUBJECT_SOURCES = ['ai', 'alpha', 'heuristic', 'manual', 'ai+manual', 'fused', 'legacy'] as const

export interface MaskPoint {
  /** Horizontal coordinate in the inclusive source-image range 0..1. */
  x: number
  /** Vertical coordinate in the inclusive source-image range 0..1. */
  y: number
}

export type MaskStrokeMode = 'select' | 'add' | 'erase'

export interface MaskStroke {
  id: string
  mode: MaskStrokeMode
  points: readonly MaskPoint[]
  /** Circular brush radius relative to the shorter source-image edge. */
  radiusNormalized: number
}

export interface MaskCorrectionDraft {
  baseEvidence: SubjectMaskEvidence
  strokes: readonly MaskStroke[]
  mask: BinaryMask
}

export interface MaskEditSession {
  baseRevision: string
  /** Complete stroke history, including entries after the current cursor for redo. */
  strokes: readonly MaskStroke[]
  /** Number of strokes currently applied from the start of the history. */
  cursor: number
}

function assertFiniteRange(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be within ${minimum}..${maximum}`)
  }
}

function validateMask(mask: BinaryMask): void {
  if (mask === null || typeof mask !== 'object') {
    throw new RangeError('Mask must be an object')
  }
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height)
    || mask.width < 1 || mask.height < 1
    || mask.width > MAX_MASK_SIDE || mask.height > MAX_MASK_SIDE) {
    throw new RangeError(`Mask dimensions must be positive integers up to ${MAX_MASK_SIDE}`)
  }
  if (!(mask.values instanceof Float32Array)
    || mask.values.length !== mask.width * mask.height) {
    throw new RangeError('Mask values length must equal width * height')
  }
  for (let index = 0; index < mask.values.length; index += 1) {
    assertFiniteRange(mask.values[index]!, `Mask value ${index}`, 0, 1)
  }
}

function validateEvidence(evidence: SubjectMaskEvidence): void {
  if (evidence === null || typeof evidence !== 'object') {
    throw new RangeError('Subject mask evidence must be an object')
  }
  validateMask(evidence.mask)
  assertFiniteRange(evidence.confidence, 'Subject mask confidence', 0, 1)
  if (typeof evidence.revision !== 'string' || evidence.revision.trim().length === 0) {
    throw new RangeError('Subject mask revision must be non-empty')
  }
  if (!SUBJECT_SOURCES.includes(evidence.source)) {
    throw new RangeError('Subject mask source is unsupported')
  }
  if (evidence.userConfirmed !== undefined && typeof evidence.userConfirmed !== 'boolean') {
    throw new RangeError('Subject mask userConfirmed must be boolean')
  }
  if (evidence.provenance !== undefined && !Array.isArray(evidence.provenance)) {
    throw new RangeError('Evidence provenance must be an array')
  }
  for (const entry of evidence.provenance ?? []) {
    if (entry === null || typeof entry !== 'object'
      || !EVIDENCE_ORIGINS.includes(entry.origin)) {
      throw new RangeError('Evidence provenance origin is unsupported')
    }
    if (typeof entry.provider !== 'string' || entry.provider.trim().length === 0) {
      throw new RangeError('Evidence provenance provider must be non-empty')
    }
    if (entry.model !== undefined && typeof entry.model !== 'string') {
      throw new RangeError('Evidence provenance model must be a string')
    }
    if (entry.version !== undefined && typeof entry.version !== 'string') {
      throw new RangeError('Evidence provenance version must be a string')
    }
  }
}

function validateStrokeLog(strokes: readonly MaskStroke[]): void {
  if (!Array.isArray(strokes)) {
    throw new RangeError('Mask correction strokes must be an array')
  }
  if (strokes.length > MAX_STROKES) {
    throw new RangeError(`Mask correction supports at most ${MAX_STROKES} strokes`)
  }
  const ids = new Set<string>()
  let totalPoints = 0
  for (const stroke of strokes) {
    if (stroke === null || typeof stroke !== 'object') {
      throw new RangeError('Mask stroke must be an object')
    }
    if (typeof stroke.id !== 'string') {
      throw new RangeError('Mask stroke id must be a string')
    }
    const id = stroke.id.trim()
    if (id.length === 0) throw new RangeError('Mask stroke id must be non-empty')
    if (ids.has(id)) throw new RangeError(`Duplicate stroke id: ${id}`)
    ids.add(id)
    if (stroke.mode !== 'select' && stroke.mode !== 'add' && stroke.mode !== 'erase') {
      throw new RangeError('Mask stroke mode must be select, add, or erase')
    }
    assertFiniteRange(stroke.radiusNormalized, 'Mask stroke radiusNormalized', Number.EPSILON, 1)
    if (!Array.isArray(stroke.points)) {
      throw new RangeError('Mask stroke points must be an array')
    }
    if (stroke.points.length < 1 || stroke.points.length > MAX_POINTS_PER_STROKE) {
      throw new RangeError(`Mask stroke points must contain 1..${MAX_POINTS_PER_STROKE} entries`)
    }
    if (stroke.mode === 'select' && stroke.points.length < 3) {
      throw new RangeError('Mask selection must contain at least three points')
    }
    totalPoints += stroke.points.length
    if (totalPoints > MAX_TOTAL_POINTS) {
      throw new RangeError(`Mask correction supports at most ${MAX_TOTAL_POINTS} total points`)
    }
    for (const point of stroke.points) {
      if (point === null || typeof point !== 'object') {
        throw new RangeError('Mask stroke points must contain coordinate objects')
      }
      assertFiniteRange(point.x, 'Mask stroke points.x', 0, 1)
      assertFiniteRange(point.y, 'Mask stroke points.y', 0, 1)
    }
  }
}

function cloneMask(mask: BinaryMask): BinaryMask {
  return {
    width: mask.width,
    height: mask.height,
    values: new Float32Array(mask.values),
  }
}

function cloneStroke(stroke: MaskStroke): MaskStroke {
  return {
    id: stroke.id.trim(),
    mode: stroke.mode,
    points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
    radiusNormalized: stroke.radiusNormalized,
  }
}

function validateEditSession(session: MaskEditSession): void {
  if (session === null || typeof session !== 'object') {
    throw new RangeError('Mask edit session must be an object')
  }
  if (typeof session.baseRevision !== 'string' || session.baseRevision.trim().length === 0) {
    throw new RangeError('Mask edit session base revision must be non-empty')
  }
  validateStrokeLog(session.strokes)
  if (!Number.isInteger(session.cursor)
    || session.cursor < 0
    || session.cursor > session.strokes.length) {
    throw new RangeError('Mask edit session cursor must address the stroke history')
  }
}

export function createMaskEditSession(
  baseRevision: string,
  strokes: readonly MaskStroke[] = [],
  cursor: number = strokes.length,
): MaskEditSession {
  const input = {
    baseRevision,
    strokes,
    cursor,
  }
  validateEditSession(input)
  return {
    ...input,
    strokes: strokes.map(cloneStroke),
  }
}

export function activeMaskStrokes(session: MaskEditSession): readonly MaskStroke[] {
  validateEditSession(session)
  return session.strokes.slice(0, session.cursor)
}

export function appendMaskEditStroke(
  session: MaskEditSession,
  stroke: MaskStroke,
): MaskEditSession {
  validateEditSession(session)
  const input = [...session.strokes.slice(0, session.cursor), stroke]
  validateStrokeLog(input)
  const strokes = [...session.strokes.slice(0, session.cursor), cloneStroke(stroke)]
  return {
    baseRevision: session.baseRevision,
    strokes,
    cursor: strokes.length,
  }
}

export function undoMaskEdit(session: MaskEditSession): MaskEditSession {
  validateEditSession(session)
  if (session.cursor === 0) return session
  return { ...session, cursor: session.cursor - 1 }
}

export function redoMaskEdit(session: MaskEditSession): MaskEditSession {
  validateEditSession(session)
  if (session.cursor === session.strokes.length) return session
  return { ...session, cursor: session.cursor + 1 }
}

function paintBrush(
  values: Float32Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  mode: Exclude<MaskStrokeMode, 'select'>,
): void {
  const radiusSquared = radius * radius
  const minimumX = Math.max(0, Math.floor(centerX - radius))
  const maximumX = Math.min(width - 1, Math.ceil(centerX + radius))
  const minimumY = Math.max(0, Math.floor(centerY - radius))
  const maximumY = Math.min(height - 1, Math.ceil(centerY + radius))
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared > radiusSquared) continue
      const index = y * width + x
      values[index] = mode === 'add' ? 1 : 0
    }
  }
}

function rasterizePolygon(
  width: number,
  height: number,
  points: readonly MaskPoint[],
): Uint8Array {
  const inside = new Uint8Array(width * height)
  const pixelPoints = points.map((point) => ({
    x: point.x * Math.max(0, width - 1),
    y: point.y * Math.max(0, height - 1),
  }))
  for (let y = 0; y < height; y += 1) {
    const sampleY = y + 0.5
    const intersections: number[] = []
    for (let index = 0; index < pixelPoints.length; index += 1) {
      const start = pixelPoints[index]!
      const end = pixelPoints[(index + 1) % pixelPoints.length]!
      if ((start.y > sampleY) === (end.y > sampleY)) continue
      const progress = (sampleY - start.y) / (end.y - start.y)
      intersections.push(start.x + (end.x - start.x) * progress)
    }
    intersections.sort((first, second) => first - second)
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const startX = Math.max(0, Math.ceil(intersections[index]! - 0.5))
      const endX = Math.min(width - 1, Math.floor(intersections[index + 1]! - 0.5))
      for (let x = startX; x <= endX; x += 1) inside[y * width + x] = 1
    }
  }
  return inside
}

function selectMaskComponents(
  values: Float32Array,
  width: number,
  height: number,
  points: readonly MaskPoint[],
): void {
  const inside = rasterizePolygon(width, height, points)
  const labels = new Int32Array(values.length)
  const queue = new Int32Array(values.length)
  const components: Array<{ id: number; size: number; overlap: number }> = []
  let nextId = 1

  for (let start = 0; start < values.length; start += 1) {
    if (values[start]! < 0.5 || labels[start] !== 0) continue
    const id = nextId
    nextId += 1
    let head = 0
    let tail = 0
    let size = 0
    let overlap = 0
    queue[tail] = start
    tail += 1
    labels[start] = id
    while (head < tail) {
      const current = queue[head]!
      head += 1
      size += 1
      overlap += inside[current] ?? 0
      const x = current % width
      const y = Math.floor(current / width)
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]
      for (const neighbor of neighbors) {
        if (neighbor < 0 || values[neighbor]! < 0.5 || labels[neighbor] !== 0) continue
        labels[neighbor] = id
        queue[tail] = neighbor
        tail += 1
      }
    }
    components.push({ id, size, overlap })
  }

  const selected = new Set(components
    .filter((component) => component.overlap > 0
      && (component.overlap / component.size >= 0.08 || component.overlap >= 16))
    .map((component) => component.id))
  if (selected.size === 0) {
    const best = [...components].sort((first, second) => second.overlap - first.overlap)[0]
    if (best !== undefined && best.overlap > 0) selected.add(best.id)
  }

  values.fill(0)
  if (selected.size === 0) {
    for (let index = 0; index < values.length; index += 1) values[index] = inside[index] ?? 0
    return
  }
  for (let index = 0; index < values.length; index += 1) {
    if (selected.has(labels[index]!)) values[index] = 1
  }
}

function binaryMask(mask: BinaryMask): BinaryMask {
  return {
    width: mask.width,
    height: mask.height,
    values: Float32Array.from(mask.values, (value) => value >= 0.5 ? 1 : 0),
  }
}

function paintStroke(values: Float32Array, width: number, height: number, stroke: MaskStroke): number {
  if (stroke.mode === 'select') {
    selectMaskComponents(values, width, height, stroke.points)
    return stroke.points.length
  }
  const radius = Math.max(0.5, stroke.radiusNormalized * Math.min(width, height))
  const maximumSpacing = Math.max(0.25, radius * 0.5)
  const toPixel = (point: MaskPoint): readonly [number, number] => [
    point.x * Math.max(0, width - 1),
    point.y * Math.max(0, height - 1),
  ]
  let samples = 0
  const first = toPixel(stroke.points[0]!)
  paintBrush(values, width, height, first[0], first[1], radius, stroke.mode)
  samples += 1
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = toPixel(stroke.points[index - 1]!)
    const end = toPixel(stroke.points[index]!)
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / maximumSpacing))
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps
      paintBrush(
        values,
        width,
        height,
        start[0] + dx * progress,
        start[1] + dy * progress,
        radius,
        stroke.mode,
      )
    }
    samples += steps
    if (samples > MAX_INTERPOLATED_SAMPLES) {
      throw new RangeError('Mask correction stroke path exceeds the processing budget')
    }
  }
  return samples
}

export function applyMaskStrokes(baseMask: BinaryMask, strokes: readonly MaskStroke[]): BinaryMask {
  validateMask(baseMask)
  validateStrokeLog(strokes)
  return applyValidatedMaskStrokes(baseMask, strokes)
}

function applyValidatedMaskStrokes(baseMask: BinaryMask, strokes: readonly MaskStroke[]): BinaryMask {
  const corrected = cloneMask(baseMask)
  let samples = 0
  for (const stroke of strokes) {
    samples += paintStroke(corrected.values, corrected.width, corrected.height, stroke)
    if (samples > MAX_INTERPOLATED_SAMPLES) {
      throw new RangeError('Mask correction stroke log exceeds the processing budget')
    }
  }
  return corrected
}

function cloneEvidence(evidence: SubjectMaskEvidence): SubjectMaskEvidence {
  const provenance = normalizeEvidenceProvenance(evidence.provenance)
  return {
    ...evidence,
    mask: cloneMask(evidence.mask),
    ...(provenance.length === 0 ? {} : { provenance }),
  }
}

export function createMaskCorrectionDraft(
  baseEvidence: SubjectMaskEvidence,
  strokes: readonly MaskStroke[] = [],
): MaskCorrectionDraft {
  validateEvidence(baseEvidence)
  validateStrokeLog(strokes)
  const stableBase = cloneEvidence(baseEvidence)
  const stableStrokes = strokes.map(cloneStroke)
  return {
    baseEvidence: stableBase,
    strokes: stableStrokes,
    mask: applyValidatedMaskStrokes(stableBase.mask, stableStrokes),
  }
}

export function createMaskCorrectionDraftFromSession(
  baseEvidence: SubjectMaskEvidence,
  session: MaskEditSession,
): MaskCorrectionDraft {
  validateEvidence(baseEvidence)
  validateEditSession(session)
  if (baseEvidence.revision !== session.baseRevision) {
    throw new RangeError('Mask edit session base revision must match the subject evidence')
  }
  return createMaskCorrectionDraft(baseEvidence, activeMaskStrokes(session))
}

export function applyMaskStroke(draft: MaskCorrectionDraft, stroke: MaskStroke): MaskCorrectionDraft {
  if (draft === null || typeof draft !== 'object') {
    throw new RangeError('Mask correction draft must be an object')
  }
  validateMask(draft.mask)
  if (draft.mask.width !== draft.baseEvidence.mask.width
    || draft.mask.height !== draft.baseEvidence.mask.height) {
    throw new RangeError('Mask correction draft dimensions must match the base evidence')
  }
  const strokes = [...draft.strokes, stroke]
  validateStrokeLog(strokes)
  const stableStroke = cloneStroke(stroke)
  return {
    baseEvidence: draft.baseEvidence,
    strokes: [...draft.strokes, stableStroke],
    mask: applyValidatedMaskStrokes(draft.mask, [stableStroke]),
  }
}

function textFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ (code & 0xff), 0x01000193)
    first = Math.imul(first ^ (code >>> 8), 0x01000193)
    second = Math.imul(second ^ (code & 0xff), 0x85ebca6b)
    second = Math.imul(second ^ (code >>> 8), 0x85ebca6b)
  }
  return [first, second]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

function canonicalStrokeLog(strokes: readonly MaskStroke[]): string {
  return JSON.stringify(strokes.map((stroke) => [
    stroke.id.trim(),
    stroke.mode,
    stroke.radiusNormalized,
    stroke.points.map((point) => [point.x, point.y]),
  ]))
}

function correctedSource(base: SubjectMaskEvidence): SubjectMaskSource {
  const includesModel = base.source === 'ai'
    || base.source === 'ai+manual'
    || (base.provenance ?? []).some((entry) => entry.origin === 'model')
  return includesModel ? 'ai+manual' : 'manual'
}

function correctionProvenance(base: SubjectMaskEvidence): readonly EvidenceProvenance[] {
  return normalizeEvidenceProvenance([
    ...(base.provenance ?? []),
    { origin: 'manual', provider: 'mask-editor', version: '1' },
  ])
}

function confirmEvidenceWithStrokes(
  baseEvidence: SubjectMaskEvidence,
  strokes: readonly MaskStroke[],
): SubjectMaskEvidence {
  validateEvidence(baseEvidence)
  validateStrokeLog(strokes)
  const mask = binaryMask(applyValidatedMaskStrokes(baseEvidence.mask, strokes))
  const baseIdentity = [
    baseEvidence.revision,
    baseEvidence.mask.width.toString(),
    baseEvidence.mask.height.toString(),
    numericArrayFingerprintSync(baseEvidence.mask.values),
  ].join(':')
  const revision = `mask-editor:v1:${textFingerprint(`${baseIdentity}\u0000${canonicalStrokeLog(strokes)}`)}`
  return {
    mask,
    confidence: baseEvidence.confidence,
    source: correctedSource(baseEvidence),
    revision,
    userConfirmed: true,
    provenance: correctionProvenance(baseEvidence),
  }
}

export function confirmMaskCorrection(draft: MaskCorrectionDraft): SubjectMaskEvidence {
  if (draft === null || typeof draft !== 'object') {
    throw new RangeError('Mask correction draft must be an object')
  }
  return confirmEvidenceWithStrokes(draft.baseEvidence, draft.strokes)
}

export function confirmMaskEditSession(
  baseEvidence: SubjectMaskEvidence,
  session: MaskEditSession,
): SubjectMaskEvidence {
  validateEvidence(baseEvidence)
  validateEditSession(session)
  if (baseEvidence.revision !== session.baseRevision) {
    throw new RangeError('Mask edit session base revision must match the subject evidence')
  }
  return confirmEvidenceWithStrokes(baseEvidence, activeMaskStrokes(session))
}
