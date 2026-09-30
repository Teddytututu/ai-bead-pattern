import test from 'node:test'
import assert from 'node:assert/strict'
import { importProductGrid, eyeRectangle, mergeEyeGuidance, PRODUCT_MASK_PURPOSE } from '../../src/eye-region-guidance.mjs'
import { createEyeAnnotation, validateEyeAnnotation } from '../../../training-annotation/state.mjs'
const grid={width:4,height:3,paletteId:'test',paletteVersion:'1',colors:[{id:'skin',rgb:[230,180,150]}],cells:Array(12).fill(0)}
test('product eye guidance bounds rectangles and combines manual additions without changing its source',()=>{
  const before=structuredClone(grid),painted=Array(12).fill(false);painted[0]=true
  const box=eyeRectangle({x:3,y:2},{x:1,y:1},grid)
  assert.deepEqual(box,{x:1,y:1,width:3,height:2})
  assert.equal(mergeEyeGuidance(grid,painted,[box]).filter(Boolean).length,7)
  assert.deepEqual(eyeRectangle({x:-3,y:0},{x:9,y:8},grid),{x:0,y:0,width:4,height:3})
  assert.deepEqual(grid,before);assert.equal(PRODUCT_MASK_PURPOSE,'region-guidance')
})
test('training targets and inference guidance are not interchangeable and old sealed contracts remain readable',()=>{
  const training=createEyeAnnotation(grid)
  assert.equal(training.maskPurpose,'training-target')
  assert.throws(()=>importProductGrid(training),/训练标注文件/)
  assert.throws(()=>validateEyeAnnotation({...training,maskPurpose:'region-guidance'}),/确定性目标/)
  const legacy=structuredClone(training);delete legacy.maskPurpose
  assert.equal(validateEyeAnnotation(legacy).schemaVersion,'eye-annotation-v1')
  assert.deepEqual(importProductGrid(grid),grid)
})
