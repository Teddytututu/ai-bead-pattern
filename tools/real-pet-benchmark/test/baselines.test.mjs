import test from 'node:test'
import assert from 'node:assert/strict'
import { BASELINES, baselineStatus, optionsForBaseline, resolveBaselineIds } from '../src/baselines.mjs'

test('registry exposes runnable deterministic area and nearest baselines', () => {
  assert.deepEqual(resolveBaselineIds('area,nearest'), ['area', 'nearest'])
  for (const id of ['area', 'nearest']) {
    const status = baselineStatus(id)
    assert.equal(status.runStatus, 'runnable')
    assert.equal(status.paperReproduction, false)
    const options = optionsForBaseline(id, { size: { width: 24, height: 24 } })
    assert.equal(options.baseline, id === 'area' ? 'a1' : 'a0')
    assert.equal(options.resizeMethod, id)
  }
})

test('PixelOE adapter identifies itself as a heuristic proxy', () => {
  const status = baselineStatus('pixeloe')
  assert.equal(status.runStatus, 'runnable')
  assert.equal(status.implementationStatus, 'adapted-heuristic')
  assert.equal(status.paperReproduction, false)
  assert.match(status.source, /PixelOE/)
  assert.equal(optionsForBaseline('pixeloe', { size: { width: 32, height: 32 } }).structure.outlineMode, 'full')
})

test('MYOS remains explicitly skipped until an external command is configured', () => {
  const prior = process.env.MYOS_COMMAND
  delete process.env.MYOS_COMMAND
  const status = baselineStatus('myos')
  assert.equal(status.runStatus, 'skipped')
  assert.equal(status.paperReproduction, false)
  assert.match(status.skipReason, /MYOS_COMMAND/)
  if (prior === undefined) delete process.env.MYOS_COMMAND
  else process.env.MYOS_COMMAND = prior
})

test('unknown baseline is rejected', () => {
  assert.throws(() => resolveBaselineIds('area,unknown'), /Unknown baseline/)
  assert.ok(BASELINES.myos.license)
})
