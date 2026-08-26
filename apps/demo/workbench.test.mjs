import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('workbench product controls', () => {
  it('exposes grid refinement, planning diagnostics, and daily preference capture', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /id="refinementModeControl"/)
    assert.match(html, /id="gridRefinementEnergy"/)
    assert.match(html, /id="structureRegionCount"/)
    assert.match(html, /id="valueRoleCount"/)
    assert.match(html, /id="paletteRoleCount"/)
    assert.match(html, /id="preferencePanel"/)
    assert.match(html, /id="preferenceCanvasA"/)
    assert.match(html, /id="preferenceCanvasB"/)
  })

  it('fits rectangular uploads into square previews with their aspect ratio intact', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /Math\.min\(canvas\.width \/ buffer\.width, canvas\.height \/ buffer\.height\)/)
    assert.match(html, /\(canvas\.width - width\) \/ 2/)
    assert.match(html, /\(canvas\.height - height\) \/ 2/)
  })
})
