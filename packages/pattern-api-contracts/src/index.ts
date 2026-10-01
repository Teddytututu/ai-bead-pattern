import type { MaterialColor, PatternOptions, PatternStyle, PatternDocument, GenerationStatus, StructureOptions, PatternCandidate } from '../../pattern-core/dist/index.js'
export type Route = 'deterministic' | 'neural-analysis'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface CreateJobRequest {
  imageId: string
  paletteId: string
  paletteVersion?: string
  route: Route
  consentToRemoteAnalysis?: boolean
  failureMode: 'strict' | 'best-effort'
  options: PatternOptions
}
export interface CreateJobInput {
  imageId: string; paletteId?: string; paletteVersion?: string; route?: Route; failureMode?: 'strict' | 'best-effort'
  consentToRemoteAnalysis?: boolean
  options?: {
    canvas?: { mode: 'auto' } | { mode: 'fixed'; size: { width: number; height: number } }
    maxColors?: number; maxCandidates?: number; styles?: PatternStyle[]
    imageType?: 'general' | 'portrait' | 'pet' | 'illustration' | 'landscape'
    structure?: Pick<StructureOptions, 'occupancyMode' | 'valueMode' | 'valueStrength' | 'valueLevels' | 'outlineMode' | 'contours'>
    optimization?: { refinementMode: 'fast' | 'quality' }
  }
}
export interface ApiErrorBody { code: string; message: string; retryable: boolean }
export type ApiResponse<T> = { data: T; requestId: string } | { error: ApiErrorBody; requestId: string }
export interface JobView {
  jobId: string; state: JobState; stage: string; createdAt: number; updatedAt: number; expiresAt: number
  pollAfterMs: number; statusUrl: string; resultUrl?: string; error?: ApiErrorBody
}
export interface ImageView { imageId: string; width: number; height: number; expiresAt: number }
export interface SessionView { token: string; expiresAt: number }
export interface CandidateView { id: string; style: string; valid: boolean; score: number; reasons: readonly string[]; pattern: PatternDocument; contourPlan?: PatternCandidate['contourPlan'] }
export interface ResultView {
  generationId: string; generationStatus: GenerationStatus; actualRoute: Route
  recommendedId?: string; bestEffortId?: string; candidates: CandidateView[]; warnings: string[]
}
export interface PaletteSummary { id: string; name: string; version: string; colorCount: number; automaticColorCount?: number; brand?: string }
export interface PaletteView extends PaletteSummary {
  colors: MaterialColor[]
  rgbKind?: string
}
export const apiLimits = Object.freeze({
  uploadBytes: 5 * 1024 * 1024, sourcePixels: 20_000_000, normalizedSide: 1024,
  maxColors: 48, maxCandidates: 3, gridSizes: [32, 48, 64, 96] as readonly number[],
})
export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractError' }
}
export function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('Expected an object')
  if (keys && Object.keys(value).some(k => !keys.includes(k))) throw new ContractError('Unknown request field')
  return value as Record<string, unknown>
}
export function nonempty(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ContractError(`Invalid ${label}`)
  return value
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ContractError(`Invalid ${label}`)
  return value
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ContractError(`Invalid ${label}`)
  return value as T
}
export function parseCreateJob(input: unknown): CreateJobRequest {
  const value = record(input, ['imageId', 'paletteId', 'paletteVersion', 'route', 'failureMode', 'options', 'consentToRemoteAnalysis'])
  if (value.consentToRemoteAnalysis !== undefined && typeof value.consentToRemoteAnalysis !== 'boolean') throw new ContractError('Invalid remote analysis consent')
  const raw = record(value.options ?? {}, ['canvas', 'maxColors', 'maxCandidates', 'styles', 'imageType', 'structure', 'optimization'])
  const canvas = record(raw.canvas ?? { mode: 'fixed', size: { width: 48, height: 48 } }, ['mode', 'size'])
  let chosenCanvas: PatternOptions['canvas']
  if (canvas.mode === 'auto') {
    if (canvas.size !== undefined) throw new ContractError('Auto canvas must not include size')
    chosenCanvas = { mode: 'auto', candidates: [32, 48, 64].map(side => ({ width: side, height: side })) }
  } else {
    if (canvas.mode !== 'fixed') throw new ContractError('Invalid canvas mode')
    const size = record(canvas.size, ['width', 'height'])
    const width = integer(size.width, 32, 96, 'width')
    if (size.height !== width || !apiLimits.gridSizes.includes(width)) throw new ContractError('Unsupported grid size')
    chosenCanvas = { mode: 'fixed', size: { width, height: width } }
  }
  const styles = raw.styles ?? ['faithful', 'simple', 'high-contrast']
  if (!Array.isArray(styles) || styles.length < 1 || styles.length > 3 || new Set(styles).size !== styles.length) throw new ContractError('Choose one to three unique styles')
  const structure = record(raw.structure ?? {}, ['occupancyMode', 'valueMode', 'valueStrength', 'valueLevels', 'outlineMode', 'contours'])
  const contours = structure.contours === undefined ? undefined : record(structure.contours, ['external', 'internal', 'colorId'])
  if (contours) {
    for (const key of ['external', 'internal']) if (contours[key] !== undefined && typeof contours[key] !== 'boolean') throw new ContractError(`Invalid contours.${key}`)
    if (contours.colorId !== undefined) nonempty(contours.colorId, 'contours.colorId')
  }
  if (structure.valueStrength !== undefined && (typeof structure.valueStrength !== 'number' || !Number.isFinite(structure.valueStrength) || structure.valueStrength < 0 || structure.valueStrength > 1)) throw new ContractError('Invalid valueStrength')
  const optimization = record(raw.optimization ?? {}, ['refinementMode'])
  return {
    imageId: nonempty(value.imageId, 'imageId'), paletteId: nonempty(value.paletteId ?? 'mard-291', 'paletteId'),
    ...(value.paletteVersion === undefined ? {} : { paletteVersion: nonempty(value.paletteVersion, 'paletteVersion') }),
    route: choice(value.route ?? 'deterministic', ['deterministic', 'neural-analysis'], 'route'),
    ...(value.consentToRemoteAnalysis === undefined ? {} : { consentToRemoteAnalysis: value.consentToRemoteAnalysis as boolean }),
    failureMode: choice(value.failureMode ?? 'strict', ['strict', 'best-effort'], 'failureMode'),
    options: {
      canvas: chosenCanvas, maxColors: integer(raw.maxColors ?? 20, 1, apiLimits.maxColors, 'maxColors'),
      maxCandidates: integer(raw.maxCandidates ?? 3, 1, apiLimits.maxCandidates, 'maxCandidates'),
      styles: styles.map(v => choice<PatternStyle>(v, ['faithful', 'simple', 'high-contrast', 'cute', 'soft'], 'style')),
      imageType: choice(raw.imageType ?? 'general', ['general', 'portrait', 'pet', 'illustration', 'landscape'], 'imageType'),
      structure: {
        occupancyMode: choice(structure.occupancyMode ?? 'auto', ['auto', 'full-frame', 'subject-shape'], 'occupancyMode'),
        ...(structure.valueMode === undefined ? {} : { valueMode: choice(structure.valueMode, ['preserve', 'adaptive', 'stylized'], 'valueMode') }),
        ...(structure.valueStrength === undefined ? {} : { valueStrength: structure.valueStrength as number }),
        ...(structure.valueLevels === undefined ? {} : { valueLevels: integer(structure.valueLevels, 2, 4, 'valueLevels') as 2 | 3 | 4 }),
        ...(structure.outlineMode === undefined ? {} : { outlineMode: choice(structure.outlineMode, ['off', 'selective', 'full'], 'outlineMode') }),
        ...(contours === undefined ? {} : { contours: contours as NonNullable<StructureOptions['contours']> }),
      },
      optimization: { refinementMode: choice(optimization.refinementMode ?? 'fast', ['fast', 'quality'], 'refinementMode'), localSearchIterations: 1 },
    },
  }
}
