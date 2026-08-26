import {
  validateFeatureTemplate,
  type FeatureCellRole,
  type FeatureTemplate,
  type FeatureTemplateKind,
} from './feature-template.js'

function template(
  id: string,
  kind: FeatureTemplateKind,
  rows: readonly (readonly (FeatureCellRole | undefined)[])[],
  anchor: readonly [number, number],
): FeatureTemplate {
  const width = Math.max(...rows.map((row) => row.length))
  const value: FeatureTemplate = {
    id,
    kind,
    width,
    height: rows.length,
    anchor,
    cells: rows.flatMap((row, y) => row.flatMap((role, x) =>
      role === undefined ? [] : [{ x, y, role }])),
  }
  validateFeatureTemplate(value)
  return Object.freeze({
    ...value,
    anchor: Object.freeze([...value.anchor]) as unknown as readonly [number, number],
    cells: Object.freeze(value.cells.map((cell) => Object.freeze({ ...cell }))),
  })
}

const eyeDark = 'eye-dark' as const
const mouthDark = 'mouth-dark' as const
const noseBase = 'nose-base' as const

export const featureTemplateLibrary: readonly FeatureTemplate[] = Object.freeze([
  template('eye-e1', 'eye', [[eyeDark]], [0, 0]),
  template('eye-e2-h', 'eye', [[eyeDark, eyeDark]], [0, 0]),
  template('eye-e2-v', 'eye', [[eyeDark], [eyeDark]], [0, 0]),
  template('eye-e4', 'eye', [[eyeDark, eyeDark], [eyeDark, eyeDark]], [0, 0]),
  template('eye-highlight', 'eye', [[eyeDark, eyeDark], [eyeDark, 'eye-highlight']], [0, 0]),
  template('mouth-m1', 'mouth', [[mouthDark]], [0, 0]),
  template('mouth-m2', 'mouth', [[mouthDark, mouthDark]], [0, 0]),
  template('mouth-m3', 'mouth', [[mouthDark, mouthDark, mouthDark]], [1, 0]),
  template('mouth-stair', 'mouth', [[mouthDark, mouthDark], [undefined, mouthDark]], [1, 0]),
  template('mouth-open', 'mouth', [
    [mouthDark, mouthDark, mouthDark],
    [mouthDark, 'mouth-inner', mouthDark],
  ], [1, 0]),
  template('nose-n1', 'nose', [[noseBase]], [0, 0]),
  template('nose-n2', 'nose', [[noseBase, noseBase]], [0, 0]),
])

export interface FeatureTemplateSelection {
  kind: FeatureTemplateKind
  minimumCells?: number
  maximumCells: number
}

export function selectFeatureTemplates(selection: FeatureTemplateSelection): readonly FeatureTemplate[] {
  if (Number.isInteger(selection.maximumCells) === false || selection.maximumCells < 0) {
    throw new RangeError('Feature template maximum cell budget must be a non-negative integer')
  }
  const minimumCells = selection.minimumCells ?? 0
  if (Number.isInteger(minimumCells) === false || minimumCells < 0
    || minimumCells > selection.maximumCells) {
    throw new RangeError('Feature template minimum cell budget is invalid')
  }
  return featureTemplateLibrary.filter((entry) =>
    entry.kind === selection.kind
      && entry.cells.length >= minimumCells
      && entry.cells.length <= selection.maximumCells)
}
