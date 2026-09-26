import { deltaE2000, prepareColors, type PreparedColor } from '../color.js'
import type { ContourOptions, Lab, MaterialColor, OutlineMode, StructureOptions } from '../types.js'
import { isDeepSaturatedInk } from './mard-fill-policy.js'

export const contourPlannerVersion = 'mask-contours-v1'
export interface ResolvedContourOptions { external: boolean; internal: boolean; mode: OutlineMode; colorId?: string }
export function resolveContourOptions(options: StructureOptions = {}): ResolvedContourOptions {
  const external = options.contours?.external ?? options.outlineMode !== 'off'
  const internal = options.contours?.internal ?? options.outlineMode !== 'off'
  return { external, internal, mode: external || internal ? options.outlineMode === 'selective' ? 'selective' : 'full' : 'off',
    ...(options.contours?.colorId === undefined ? {} : { colorId: options.contours.colorId }) }
}
export function validateContourOptions(options: ContourOptions | undefined): void {
  if (options === undefined) return
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['external', 'internal', 'colorId'].includes(key))) throw new RangeError('Invalid contour options')
  for (const value of [options.external, options.internal]) if (value !== undefined && typeof value !== 'boolean') throw new RangeError('Contour switches must be boolean')
  if (options.colorId !== undefined && (typeof options.colorId !== 'string' || !options.colorId.trim())) throw new RangeError('Contour color id must be non-empty')
}
export interface ContourPlanningInput {
  width: number; height: number
  activeMask: Uint8Array
  /** Actual subject mask/alpha occupancy, never an invented image-frame rectangle. */
  subjectMask?: Uint8Array
  externalSource: 'subject-mask' | 'alpha' | 'unavailable'
  /** Semantic source regions, not clusters produced by color quantization. */
  regionIds: readonly (string | undefined)[]
  regionLabels?: ReadonlyMap<string, string>
  featureCells?: ReadonlySet<number>
  reservedFeatureCells?: ReadonlySet<number>
  protectedEndpoints?: ReadonlySet<number>
  pixelLabs: readonly Lab[]
  options: ResolvedContourOptions
}
export interface ContourPlan {
  version: string; width: number; height: number
  options: ResolvedContourOptions
  externalCells: readonly number[]; internalCells: readonly number[]
  colorByCell: Readonly<Record<number, string>>
  /** Present only for the strict MARD 291 outline policy. */
  colorPolicy?: 'single-deep-saturated'
  diagnostics: {
    externalSource: ContourPlanningInput['externalSource']
    internalSource: 'semantic-regions' | 'unavailable'
    externalCandidateCells: number; internalCandidateCells: number
    featureAvoidedCells: number; shortInternalCells: number; thinnedCells: number
    selectedCells: number; retainedCells: number; unresolvedContrastCells: number
    insufficientColorBudget: boolean; sourceBudgetExceededCells: number
    minimumContrast: number; warnings: readonly string[]
  }
}
const offsets = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const
function adjacent(cell: number, width: number, height: number, diagonal = false): number[] {
  const x = cell % width, y = Math.floor(cell / width)
  return offsets.flatMap(([dx, dy], index) => !diagonal && index % 2 ? []
    : x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height ? [] : [(y + dy) * width + x + dx])
}
function connectedSets(mask: Uint8Array, width: number, height: number): number[][] {
  const seen = new Uint8Array(mask.length), groups: number[][] = []
  for (let cell = 0; cell < mask.length; cell++) {
    if (!mask[cell] || seen[cell]) continue
    const group = [cell]; seen[cell] = 1
    for (let cursor = 0; cursor < group.length; cursor++) for (const next of adjacent(group[cursor]!, width, height, true)) {
      if (!mask[next] || seen[next]) continue
      seen[next] = 1; group.push(next)
    }
    groups.push(group)
  }
  return groups
}
/** Zhang–Suen deletion rules applied only to an extracted boundary band, never the filled subject. */
function thinBand(mask: Uint8Array, width: number, height: number, protectedCells: ReadonlySet<number>): number {
  let removed = 0
  for (let pass = 0; pass < Math.max(width, height); pass++) {
    let changes = 0
    for (let phase = 0; phase < 2; phase++) {
      const pending: number[] = []
      for (let cell = 0; cell < mask.length; cell++) {
        if (!mask[cell] || protectedCells.has(cell)) continue
        const x = cell % width, y = Math.floor(cell / width)
        const p = offsets.map(([dx, dy]) => x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height ? 0 : mask[(y + dy) * width + x + dx]!)
        const count = p.reduce((sum, value) => sum + value, 0)
        if (count < 2 || count > 6) continue
        const transitions = p.reduce((sum, value, index) => sum + Number(value === 0 && p[(index + 1) % 8] === 1), 0)
        if (transitions !== 1) continue
        const first = phase === 0 ? p[0]! * p[2]! * p[4]! : p[0]! * p[2]! * p[6]!
        const second = phase === 0 ? p[2]! * p[4]! * p[6]! : p[0]! * p[4]! * p[6]!
        if (first === 0 && second === 0) pending.push(cell)
      }
      for (const cell of pending) mask[cell] = 0
      changes += pending.length
    }
    removed += changes
    if (!changes) break
  }
  return removed
}
export function planContours(input: ContourPlanningInput): ContourPlan {
  const { width, height, activeMask, subjectMask, options } = input
  const cells = width * height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 96 || height > 96
    || activeMask.length !== cells || input.regionIds.length !== cells || input.pixelLabs.length !== cells
    || (subjectMask !== undefined && subjectMask.length !== cells)) throw new RangeError('Contour inputs must align with a supported grid')
  if (activeMask.some(value => value !== 0 && value !== 1) || subjectMask?.some(value => value !== 0 && value !== 1)) throw new RangeError('Contour occupancy must be binary')
  if (input.pixelLabs.some(lab => lab.length !== 3 || lab.some(value => !Number.isFinite(value)))) throw new RangeError('Contour Lab values must be finite')
  validateContourOptions({ external: options.external, internal: options.internal, ...(options.colorId === undefined ? {} : { colorId: options.colorId }) })
  if (!['off', 'selective', 'full'].includes(options.mode)) throw new RangeError('Invalid contour mode')
  const external = new Uint8Array(cells), internal = new Uint8Array(cells)
  const features = input.featureCells ?? new Set<number>(), keep = input.protectedEndpoints ?? new Set<number>()
  const moat = new Set(input.reservedFeatureCells ?? [])
  for (const cell of features) { moat.add(cell); for (const next of adjacent(cell, width, height, true)) moat.add(next) }
  const regionCounts = new Map<string, number>()
  for (let cell = 0; cell < cells; cell++) if (activeMask[cell] && input.regionIds[cell] !== undefined) regionCounts.set(input.regionIds[cell]!, (regionCounts.get(input.regionIds[cell]!) ?? 0) + 1)
  const allowedRegion = (id: string): boolean => !/background|backdrop|sky|eye|iris|pupil|mouth|nose|背景|眼|嘴|鼻/i.test(input.regionLabels?.get(id) ?? id)
  let externalCandidateCells = 0, internalCandidateCells = 0, featureAvoidedCells = 0, shortInternalCells = 0
  for (let cell = 0; cell < cells; cell++) {
    if (!activeMask[cell]) continue
    const neighbors = adjacent(cell, width, height)
    if (options.external && subjectMask?.[cell] === 1 && (neighbors.length < 4 || neighbors.some(next => !subjectMask[next]))) {
      externalCandidateCells++
      if (features.has(cell) || input.reservedFeatureCells?.has(cell)) featureAvoidedCells++
      else external[cell] = 1
    }
    const region = input.regionIds[cell]
    if (!options.internal || region === undefined || !allowedRegion(region) || (subjectMask && !subjectMask[cell])) continue
    for (const next of neighbors) {
      const other = input.regionIds[next]
      if (!activeMask[next] || other === undefined || other === region || !allowedRegion(other) || (subjectMask && !subjectMask[next])) continue
      // One consistent owner per region pair avoids the old two-cell-wide seam.
      const own = (regionCounts.get(region) ?? 0) > (regionCounts.get(other) ?? 0)
        || (regionCounts.get(region) === regionCounts.get(other) && region.localeCompare(other) < 0)
      if (!own) continue
      if (!internal[cell]) internalCandidateCells++
      internal[cell] = 1
    }
  }
  for (const group of connectedSets(internal, width, height)) if (group.length < 3 && !group.some(cell => keep.has(cell))) {
    for (const cell of group) internal[cell] = 0
    shortInternalCells += group.length
  }
  for (let cell = 0; cell < cells; cell++) {
    if (internal[cell] && moat.has(cell)) { internal[cell] = 0; featureAvoidedCells++ }
    if (external[cell]) internal[cell] = 0
  }
  const thinnedCells = thinBand(external, width, height, keep) + thinBand(internal, width, height, keep)
  // Selective is a legacy optional treatment; the structure default is full.
  if (options.mode === 'selective') for (let cell = 0; cell < cells; cell++) {
    if (!external[cell] || keep.has(cell)) continue
    const neighbors = adjacent(cell, width, height).filter(next => activeMask[next])
    if (cell % width + Math.floor(cell / width) < (width + height) / 3
      && neighbors.every(next => deltaE2000(input.pixelLabs[cell]!, input.pixelLabs[next]!) < 8)) external[cell] = 0
  }
  const externalCells = Array.from(external).flatMap((value, cell) => value ? [cell] : [])
  const internalCells = Array.from(internal).flatMap((value, cell) => value ? [cell] : [])
  const internalAvailable = [...regionCounts.keys()].filter(allowedRegion).length > 1
  const warnings: string[] = []
  if (options.external && !subjectMask) warnings.push('contour-subject-mask-unavailable')
  if (options.internal && !internalAvailable) warnings.push('contour-internal-evidence-unavailable')
  if (featureAvoidedCells) warnings.push('contour-yielded-to-features')
  return { version: contourPlannerVersion, width, height, options, externalCells, internalCells, colorByCell: {}, diagnostics: {
    externalSource: input.externalSource, internalSource: internalAvailable ? 'semantic-regions' : 'unavailable', externalCandidateCells, internalCandidateCells,
    featureAvoidedCells, shortInternalCells, thinnedCells, selectedCells: externalCells.length + internalCells.length,
    retainedCells: 0, unresolvedContrastCells: 0, insufficientColorBudget: false, sourceBudgetExceededCells: 0, minimumContrast: 10, warnings,
  } }
}

export interface ContourColorInput {
  plan: ContourPlan; pixelLabs: readonly Lab[]; activeMask: Uint8Array
  colors: readonly MaterialColor[]; initialColorIds?: readonly string[]
  inventory?: Readonly<Record<string, number>>
}
function rankedContourColors(input: ContourColorInput, colors: readonly PreparedColor[], cell: number, lines: ReadonlySet<number>): { color: PreparedColor; contrast: number; withinBudget: boolean }[] {
  const source = input.pixelLabs[cell]!
  const neighbors = adjacent(cell, input.plan.width, input.plan.height)
    .filter(next => input.activeMask[next] && !lines.has(next))
  const labs = neighbors.map(next => input.initialColorIds === undefined ? input.pixelLabs[next]!
    : colors.find(color => color.id === input.initialColorIds![next])?.lab ?? input.pixelLabs[next]!)
  const references = labs.length ? labs : [source]
  return colors.map(color => {
    const contrast = Math.min(...references.map(lab => deltaE2000(lab, color.lab)))
    const distance = deltaE2000(source, color.lab)
    const withinBudget = distance <= 20 + 1e-9 && Math.abs(source[0] - color.lab[0]) <= 20 + 1e-9
    return { color, contrast, withinBudget, cost: (withinBudget ? 0 : 10_000) + Math.max(0, 10 - contrast) * 100 + distance }
  }).sort((a, b) => a.cost - b.cost || a.color.id.localeCompare(b.color.id))
}
export function preferredContourColors(input: ContourColorInput): readonly string[] {
  const cells = [...input.plan.externalCells, ...input.plan.internalCells]
  if (!cells.length) return []
  if (input.plan.options.colorId) return [input.plan.options.colorId]
  const colors = prepareColors(input.colors).filter(color => (input.inventory?.[color.id] ?? Infinity) > 0)
  const lines = new Set(cells), counts = new Map<string, number>()
  for (const cell of cells) {
    const best = rankedContourColors(input, colors, cell, lines)[0]
    if (best) counts.set(best.color.id, (counts.get(best.color.id) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([id]) => id)
}
export function resolveContourColors(input: ContourColorInput & { initialColorIds: readonly string[] }): { plan: ContourPlan; colorIds: readonly string[] } {
  const colors = prepareColors(input.colors), colorIds = [...input.initialColorIds]
  const cells = [...input.plan.externalCells, ...input.plan.internalCells], lines = new Set(cells)
  const use = new Map<string, number>()
  colorIds.forEach((id, cell) => { if (input.activeMask[cell]) use.set(id, (use.get(id) ?? 0) + 1) })
  const colorByCell: Record<number, string> = {}
  if (input.plan.colorPolicy === 'single-deep-saturated' && cells.length) {
    const chosen = colors.find(color => color.id === input.plan.options.colorId)
    if (!chosen || !isDeepSaturatedInk(chosen)) throw new RangeError('The single deep saturated MARD contour ink must be reserved in the selected palette')
    const demand = cells.length + colorIds.filter((id, cell) => input.activeMask[cell] && !lines.has(cell) && id === chosen.id).length
    if (demand > (input.inventory?.[chosen.id] ?? Infinity)) throw new RangeError('Insufficient stock for the single MARD contour ink')
    for (const cell of cells) { colorIds[cell] = chosen.id; colorByCell[cell] = chosen.id }
    return { colorIds, plan: { ...input.plan, colorByCell, diagnostics: { ...input.plan.diagnostics, retainedCells: cells.length } } }
  }
  let unresolvedContrastCells = 0, sourceBudgetExceededCells = 0
  for (const cell of cells) {
    const original = colorIds[cell]!
    const ranked = rankedContourColors(input, colors, cell, lines)
    const candidates = ranked.filter(entry => entry.color.id === original || (use.get(entry.color.id) ?? 0) < (input.inventory?.[entry.color.id] ?? Infinity))
    const chosen = input.plan.options.colorId ? candidates.find(entry => entry.color.id === input.plan.options.colorId)
      : candidates.find(entry => entry.withinBudget)
    const selected = chosen ?? ranked.find(entry => entry.color.id === original)!
    colorIds[cell] = selected.color.id
    use.set(original, (use.get(original) ?? 0) - 1); use.set(selected.color.id, (use.get(selected.color.id) ?? 0) + 1)
    colorByCell[cell] = selected.color.id
    if (!chosen || selected.contrast < 10 - 1e-9) unresolvedContrastCells++
    if (!selected.withinBudget) sourceBudgetExceededCells++
  }
  const warnings = [...input.plan.diagnostics.warnings,
    ...(unresolvedContrastCells ? ['contour-color-contrast-unresolved'] : []),
    ...(sourceBudgetExceededCells ? ['contour-source-color-budget-exceeded'] : [])]
  return { colorIds, plan: { ...input.plan, colorByCell, diagnostics: { ...input.plan.diagnostics,
    retainedCells: cells.length, unresolvedContrastCells, sourceBudgetExceededCells,
    insufficientColorBudget: unresolvedContrastCells > 0, warnings } } }
}
export function finalizeContourPlan(plan: ContourPlan, colorIds: readonly string[], colors: readonly MaterialColor[], activeMask: Uint8Array): ContourPlan {
  const byId = new Map(prepareColors(colors).map(color => [color.id, color.lab]))
  const cells = [...plan.externalCells, ...plan.internalCells], lines = new Set(cells)
  let retainedCells = 0, unresolvedContrastCells = 0
  for (const cell of cells) {
    if (colorIds[cell] === plan.colorByCell[cell]) retainedCells++
    const lab = byId.get(colorIds[cell]!)!
    const neighbors = adjacent(cell, plan.width, plan.height).filter(next => activeMask[next] && !lines.has(next))
    if (neighbors.length && neighbors.some(next => deltaE2000(lab, byId.get(colorIds[next]!)!) < plan.diagnostics.minimumContrast - 1e-9)) unresolvedContrastCells++
  }
  return { ...plan, diagnostics: { ...plan.diagnostics, retainedCells, unresolvedContrastCells: Math.max(unresolvedContrastCells, plan.diagnostics.unresolvedContrastCells),
    warnings: [...new Set([...plan.diagnostics.warnings, ...(unresolvedContrastCells ? ['contour-final-contrast-unresolved'] : []), ...(retainedCells < cells.length ? ['contour-protection-violated'] : [])])] } }
}
