import { importGrid } from '../region-state.mjs'

export const PRODUCT_MASK_PURPOSE = 'region-guidance'
export function importProductGrid(value) {
  if (['eye-annotation-v1','region-annotation-v1','region-training-pair-v1'].includes(value?.schemaVersion)
    || value?.maskPurpose === 'training-target') {
    throw new Error('这是训练标注文件，请在独立训练标注端打开')
  }
  return importGrid(value)
}
export function eyeRectangle(start, end, grid) {
  const clamp=(value,max)=>Math.max(0,Math.min(max-1,value))
  const x1=clamp(start.x,grid.width),y1=clamp(start.y,grid.height)
  const x2=clamp(end.x,grid.width),y2=clamp(end.y,grid.height)
  if(![x1,y1,x2,y2].every(Number.isInteger))throw new Error('眼睛区域坐标无效')
  return {x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1)+1,height:Math.abs(y2-y1)+1}
}
export function mergeEyeGuidance(grid, painted, boxes) {
  if(painted.length!==grid.cells.length)throw new Error('辅助蒙版尺寸不匹配')
  const result=[...painted]
  for(const b of boxes){
    if(![b.x,b.y,b.width,b.height].every(Number.isInteger)||b.x<0||b.y<0||b.width<1||b.height<1||b.x+b.width>grid.width||b.y+b.height>grid.height)throw new Error('眼睛区域超出格图')
    for(let y=b.y;y<b.y+b.height;y++)for(let x=b.x;x<b.x+b.width;x++)result[y*grid.width+x]=true
  }
  return result
}
