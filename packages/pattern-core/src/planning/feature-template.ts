import type { LandmarkKind } from '../types.js'

export type FeatureTemplateKind = Extract<LandmarkKind, 'eye' | 'mouth' | 'nose'>

export type FeatureCellRole =
  | 'eye-dark'
  | 'eye-highlight'
  | 'mouth-dark'
  | 'mouth-inner'
  | 'nose-base'

export interface FeatureTemplateCell {
  x: number
  y: number
  role: FeatureCellRole
}

export interface FeatureTemplate {
  id: string
  kind: FeatureTemplateKind
  width: number
  height: number
  anchor: readonly [number, number]
  cells: readonly FeatureTemplateCell[]
}

const kinds = new Set<FeatureTemplateKind>(['eye', 'mouth', 'nose'])
const roles = new Set<FeatureCellRole>([
  'eye-dark',
  'eye-highlight',
  'mouth-dark',
  'mouth-inner',
  'nose-base',
])
const rolesByKind: Readonly<Record<FeatureTemplateKind, ReadonlySet<FeatureCellRole>>> = {
  eye: new Set(['eye-dark', 'eye-highlight']),
  mouth: new Set(['mouth-dark', 'mouth-inner']),
  nose: new Set(['nose-base']),
}

export function validateFeatureTemplate(template: FeatureTemplate): void {
  if (template.id.trim().length === 0) throw new RangeError('Feature template id must be non-empty')
  if (kinds.has(template.kind) === false) throw new RangeError('Feature template kind is invalid')
  if (Number.isInteger(template.width) === false || template.width <= 0
    || Number.isInteger(template.height) === false || template.height <= 0) {
    throw new RangeError(`Feature template ${template.id} dimensions must be positive integers`)
  }
  if (template.cells.length === 0) {
    throw new RangeError(`Feature template ${template.id} requires at least one occupied cell`)
  }
  const identities = new Set<string>()
  for (const [label, value, limit] of [
    ['anchor x', template.anchor[0], template.width],
    ['anchor y', template.anchor[1], template.height],
  ] as const) {
    if (Number.isInteger(value) === false || value < 0 || value >= limit) {
      throw new RangeError(`Feature template ${template.id} ${label} must stay inside the template`)
    }
  }
  for (const cell of template.cells) {
    if (Number.isInteger(cell.x) === false || cell.x < 0 || cell.x >= template.width
      || Number.isInteger(cell.y) === false || cell.y < 0 || cell.y >= template.height) {
      throw new RangeError(`Feature template ${template.id} has an out-of-range cell`)
    }
    if (roles.has(cell.role) === false) {
      throw new RangeError(`Feature template ${template.id} has an invalid cell role`)
    }
    if (rolesByKind[template.kind].has(cell.role) === false) {
      throw new RangeError(`Feature template ${template.id} cell role does not match its kind`)
    }
    const identity = `${cell.x},${cell.y}`
    if (identities.has(identity)) {
      throw new RangeError(`Feature template ${template.id} has duplicate occupied cells`)
    }
    identities.add(identity)
  }
}
