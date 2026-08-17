import { buildSourceShapeModel } from '../dist/experimental.js'

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
  const elapsedMs = performance.now() - startedAt
  const rssMiB = process.memoryUsage().rss / 1024 / 1024
  console.log(`${size}x${size}: ${elapsedMs.toFixed(0)} ms, ${model.contours.length} contours, ${rssMiB.toFixed(0)} MiB RSS`)
}
