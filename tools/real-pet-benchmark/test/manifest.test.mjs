import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const path = resolve(new URL('../../../tests/fixtures/real-pet-benchmark/manifest.template.json', import.meta.url).pathname)
const manifest = JSON.parse(await readFile(path, 'utf8'))

test('Oxford benchmark freezes 40 grouped real-pet records', () => {
  assert.equal(manifest.samples.length, 40)
  assert.deepEqual(manifest.targetSizes, [24, 32, 48, 64, 80])
  assert.deepEqual(manifest.splits, { development: 30, holdout: 10 })
  assert.equal(new Set(manifest.samples.map((sample) => sample.sampleId)).size, 40)
  const splitByGroup = new Map()
  for (const sample of manifest.samples) {
    const previous = splitByGroup.get(sample.sourceGroup)
    if (previous !== undefined) assert.equal(previous, sample.split)
    splitByGroup.set(sample.sourceGroup, sample.split)
    assert.match(sample.sourceUrl, /^https:\/\//)
    assert.equal(sample.category, 'pet')
  }
  assert.ok([...splitByGroup.values()].includes('development'))
  assert.ok([...splitByGroup.values()].includes('holdout'))
})
