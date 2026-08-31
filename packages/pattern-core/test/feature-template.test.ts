import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  featureTemplateLibrary,
  selectFeatureTemplates,
  validateFeatureTemplate,
} from '../src/experimental.js'

describe('feature template library', () => {
  it('provides facial, ear-tip, identity-mark, and endpoint templates with semantic roles', () => {
    assert.deepEqual(featureTemplateLibrary.map((template) => template.id), [
      'eye-e1',
      'eye-e2-h',
      'eye-e2-v',
      'eye-e4',
      'eye-highlight',
      'mouth-m1',
      'mouth-m2',
      'mouth-m3',
      'mouth-stair',
      'mouth-open',
      'nose-n1',
      'nose-n2',
      'ear-tip-e1',
      'ear-tip-stair',
      'mark-i1',
      'mark-i2',
      'mark-i4',
      'endpoint-c1',
      'endpoint-c2',
    ])
    for (const template of featureTemplateLibrary) {
      assert.doesNotThrow(() => validateFeatureTemplate(template))
      assert.ok(template.cells.every((cell) => cell.role.includes('-')))
    }
  })

  it('selects templates by feature kind and allocated cell budget', () => {
    assert.deepEqual(selectFeatureTemplates({ kind: 'eye', maximumCells: 1 })
      .map((template) => template.id), ['eye-e1'])
    assert.deepEqual(selectFeatureTemplates({ kind: 'nose', minimumCells: 2, maximumCells: 2 })
      .map((template) => template.id), ['nose-n2'])
    assert.deepEqual(selectFeatureTemplates({ kind: 'ear', minimumCells: 3, maximumCells: 3 })
      .map((template) => template.id), ['ear-tip-stair'])
    assert.deepEqual(selectFeatureTemplates({ kind: 'identity-mark', maximumCells: 1 })
      .map((template) => template.id), ['mark-i1'])
    assert.deepEqual(selectFeatureTemplates({ kind: 'custom', maximumCells: 2 })
      .map((template) => template.id), ['endpoint-c1', 'endpoint-c2'])
  })

  it('rejects a semantic role that belongs to another feature kind', () => {
    assert.throws(() => validateFeatureTemplate({
      id: 'invalid-eye',
      kind: 'eye',
      width: 1,
      height: 1,
      anchor: [0, 0],
      cells: [{ x: 0, y: 0, role: 'mouth-dark' }],
    }), /role/i)
  })
})
