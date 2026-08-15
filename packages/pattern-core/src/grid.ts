import type { GridEditRecord, OptimizationOptions } from './types.js'

export interface GridOptimizationResult {
  colorIds: readonly string[]
  edits: readonly GridEditRecord[]
  removedSmallRegions: number
}

const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const

function indexOf(x: number, y: number, width: number): number {
  return y * width + x
}

function collectComponent(
  colorIds: readonly string[],
  width: number,
  height: number,
  start: number,
  visited: Uint8Array,
): readonly number[] {
  const colorId = colorIds[start]
  const queue = [start]
  const component: number[] = []
  visited[start] = 1
  while (queue.length > 0) {
    const current = queue.pop()!
    component.push(current)
    const x = current % width
    const y = Math.floor(current / width)
    for (const [offsetX, offsetY] of neighbors) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
      const next = indexOf(nextX, nextY, width)
      if (visited[next] === 0 && colorIds[next] === colorId) {
        visited[next] = 1
        queue.push(next)
      }
    }
  }
  return component
}

function chooseNeighborColor(
  colorIds: readonly string[],
  width: number,
  height: number,
  component: readonly number[],
): string | undefined {
  const componentSet = new Set(component)
  const counts = new Map<string, number>()
  for (const current of component) {
    const x = current % width
    const y = Math.floor(current / width)
    for (const [offsetX, offsetY] of neighbors) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
      const next = indexOf(nextX, nextY, width)
      if (componentSet.has(next)) continue
      const colorId = colorIds[next]
      if (colorId !== undefined) counts.set(colorId, (counts.get(colorId) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]?.[0]
}

export function optimizeGrid(
  inputColorIds: readonly string[],
  width: number,
  height: number,
  protectedCells: ReadonlySet<number>,
  options: OptimizationOptions = {},
): GridOptimizationResult {
  const sourceColorIds = [...inputColorIds]
  const colorIds = [...inputColorIds]
  const edits: GridEditRecord[] = []
  const pendingEdits: GridEditRecord[] = []
  const minimumRegionSize = Math.max(1, Math.floor(options.minRegionSize ?? 2))
  const visited = new Uint8Array(colorIds.length)
  let removedSmallRegions = 0
  for (let start = 0; start < colorIds.length; start += 1) {
    if (visited[start] === 1) continue
    const component = collectComponent(sourceColorIds, width, height, start, visited)
    if (component.length >= minimumRegionSize || component.some((cell) => protectedCells.has(cell))) continue
    const replacement = chooseNeighborColor(sourceColorIds, width, height, component)
    if (replacement === undefined || replacement === sourceColorIds[start]) continue
    removedSmallRegions += 1
    for (const cell of component) {
      pendingEdits.push({
        x: cell % width,
        y: Math.floor(cell / width),
        fromColorId: sourceColorIds[cell]!,
        toColorId: replacement,
        reason: component.length === 1 ? 'isolated-cell' : 'small-region',
      })
    }
  }
  for (const edit of pendingEdits) {
    colorIds[indexOf(edit.x, edit.y, width)] = edit.toColorId
    edits.push(edit)
  }
  if ((options.stripePenalty ?? 0) > 0) {
    const snapshot = [...colorIds]
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const current = indexOf(x, y, width)
        if (protectedCells.has(current)) continue
        const left = snapshot[indexOf(x - 1, y, width)]
        const right = snapshot[indexOf(x + 1, y, width)]
        const top = snapshot[indexOf(x, y - 1, width)]
        const bottom = snapshot[indexOf(x, y + 1, width)]
        const replacement = left === right && left !== snapshot[current]
          ? left
          : top === bottom && top !== snapshot[current] ? top : undefined
        if (replacement !== undefined) {
          const fromColorId = colorIds[current]!
          colorIds[current] = replacement
          edits.push({ x, y, fromColorId, toColorId: replacement, reason: 'stripe' })
        }
      }
    }
  }
  return { colorIds, edits, removedSmallRegions }
}

export function countIsolatedCells(colorIds: readonly string[], width: number, height: number): number {
  let isolated = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = colorIds[indexOf(x, y, width)]
      let matches = 0
      for (const [offsetX, offsetY] of neighbors) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height
          && colorIds[indexOf(nextX, nextY, width)] === current) matches += 1
      }
      if (matches === 0) isolated += 1
    }
  }
  return isolated
}

export function countThinStripes(colorIds: readonly string[], width: number, height: number): number {
  let stripes = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const current = colorIds[indexOf(x, y, width)]
      const horizontal = colorIds[indexOf(x - 1, y, width)] === colorIds[indexOf(x + 1, y, width)]
        && colorIds[indexOf(x - 1, y, width)] !== current
      const vertical = colorIds[indexOf(x, y - 1, width)] === colorIds[indexOf(x, y + 1, width)]
        && colorIds[indexOf(x, y - 1, width)] !== current
      if (horizontal || vertical) stripes += 1
    }
  }
  return stripes
}
