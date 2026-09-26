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
  expression: FeatureTemplate['expression'] = 'neutral',
): FeatureTemplate {
  const width = Math.max(...rows.map((row) => row.length))
  const value: FeatureTemplate = {
    id,
    kind,
    width,
    height: rows.length,
    anchor,
    version: 'feature-templates-v2',
    expression,
    source: { kind: 'original', description: 'Project-authored component stencil; public Perler projects used only as visual research references.' },
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
const earTip = 'ear-tip' as const
const identityDark = 'identity-dark' as const
const endpointDark = 'endpoint-dark' as const

export const featureTemplateLibrary: readonly FeatureTemplate[] = Object.freeze([
  template('eye-e1', 'eye', [[eyeDark]], [0, 0]),
  template('eye-e2-h', 'eye', [[eyeDark, 'eye-highlight']], [0, 0]),
  template('eye-e2-v', 'eye', [[eyeDark], ['eye-highlight']], [0, 0]),
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
  template('ear-tip-e1', 'ear', [[earTip]], [0, 0]),
  template('ear-tip-stair', 'ear', [[earTip, earTip], [undefined, earTip]], [1, 1]),
  template('mark-i1', 'identity-mark', [[identityDark]], [0, 0]),
  template('mark-i2', 'identity-mark', [[identityDark, identityDark]], [0, 0]),
  template('mark-i4', 'identity-mark', [[identityDark, identityDark], [identityDark, identityDark]], [0, 0]),
  template('endpoint-c1', 'custom', [[endpointDark]], [0, 0]),
  template('endpoint-c2', 'custom', [[endpointDark, endpointDark]], [0, 0]),
  template('eye-closed-2x1', 'eye', [[eyeDark, eyeDark]], [0, 0], 'closed'),
  template('eye-closed-3x2', 'eye', [[eyeDark, undefined, eyeDark], [undefined, eyeDark, undefined]], [1, 1], 'closed'),
  template('eye-open-2x3', 'eye', [[eyeDark, eyeDark], ['eye-highlight', 'eye-iris'], [eyeDark, eyeDark]], [0, 1], 'open'),
  template('eye-open-3x2', 'eye', [[eyeDark, 'eye-highlight', eyeDark], [eyeDark, 'eye-iris', eyeDark]], [1, 0], 'open'),
  template('eye-open-3x3', 'eye', [[undefined, eyeDark, undefined], [eyeDark, 'eye-highlight', 'eye-iris'], [undefined, eyeDark, undefined]], [1, 1], 'open'),
  template('eye-open-3x4', 'eye', [[undefined, eyeDark, undefined], [eyeDark, 'eye-highlight', eyeDark], [eyeDark, 'eye-iris', eyeDark], [undefined, eyeDark, undefined]], [1, 1], 'open'),
  template('eye-open-4x3', 'eye', [[undefined, eyeDark, eyeDark, undefined], [eyeDark, 'eye-highlight', 'eye-iris', eyeDark], [undefined, eyeDark, eyeDark, undefined]], [1, 1], 'open'),
  template('eye-open-4x4', 'eye', [[undefined, eyeDark, eyeDark, undefined], [eyeDark, 'eye-highlight', 'eye-iris', eyeDark], [eyeDark, 'eye-white', 'eye-iris', eyeDark], [undefined, eyeDark, eyeDark, undefined]], [1, 1], 'open'),
  template('eye-open-5x5', 'eye', [[undefined, eyeDark, eyeDark, eyeDark, undefined], [eyeDark, 'eye-white', 'eye-highlight', 'eye-iris', eyeDark], [eyeDark, 'eye-white', eyeDark, 'eye-iris', eyeDark], [eyeDark, 'eye-white', 'eye-iris', 'eye-iris', eyeDark], [undefined, eyeDark, eyeDark, eyeDark, undefined]], [2, 2], 'open'),
  template('nose-2x2', 'nose', [[noseBase, noseBase], [undefined, noseBase]], [0, 0]),
  template('nose-3x2', 'nose', [[noseBase, noseBase, noseBase], [undefined, noseBase, undefined]], [1, 0]),
  template('nose-3x3', 'nose', [[undefined, noseBase, undefined], [noseBase, noseBase, noseBase], [undefined, noseBase, undefined]], [1, 1]),
  template('mouth-open-2x3', 'mouth', [[mouthDark, mouthDark], ['mouth-inner', mouthDark], [mouthDark, mouthDark]], [0, 1], 'open'),
  template('mouth-open-3x3', 'mouth', [[mouthDark, mouthDark, mouthDark], [mouthDark, 'mouth-inner', mouthDark], [mouthDark, mouthDark, mouthDark]], [1, 1], 'open'),
  template('mouth-smile-3x3', 'mouth', [[mouthDark, undefined, mouthDark], [mouthDark, undefined, mouthDark], [undefined, mouthDark, undefined]], [1, 1], 'smile'),
  template('mouth-smile-5x3', 'mouth', [[mouthDark, undefined, undefined, undefined, mouthDark], [undefined, mouthDark, undefined, mouthDark, undefined], [undefined, undefined, mouthDark, undefined, undefined]], [2, 1], 'smile'),
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
