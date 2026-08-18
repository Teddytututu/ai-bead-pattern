import { ShapeVariantCache, buildSourceShapeModel } from '../dist/experimental.js'

function benchmarkMask(size) {
  const values = new Float32Array(size * size)
  const margin = Math.max(24, Math.floor(size / 16))
  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      if ((x + y) % 17 !== 0) values[y * size + x] = 1
    }
  }
  return { width: size, height: size, values }
}

for (const size of [512, 2048]) {
  const startedAt = performance.now()
  const model = buildSourceShapeModel(benchmarkMask(size), 1)
  const modelElapsedMs = performance.now() - startedAt
  const cache = new ShapeVariantCache(model, [])
  const rasterStartedAt = performance.now()
  for (const side of [32, 48, 64]) {
    cache.get({
      crop: { x: 0, y: 0, width: size, height: size },
      size: { width: side, height: side },
      occupancyMode: 'subject-shape',
      refinementIterations: 2,
    })
  }
  const rasterElapsedMs = performance.now() - rasterStartedAt
  const rssMiB = process.memoryUsage().rss / 1024 / 1024
  console.log(`${size}x${size}: model ${modelElapsedMs.toFixed(0)} ms, 3 variants ${rasterElapsedMs.toFixed(0)} ms, ${model.contours.length} contours, ${rssMiB.toFixed(0)} MiB RSS`)
}
