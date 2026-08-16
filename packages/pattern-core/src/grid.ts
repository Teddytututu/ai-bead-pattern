import type { GridEditRecord, OptimizationOptions } from './types.js'

export interface GridOptimizationResult {
  colorIds: readonly string[]
  edits: readonly GridEditRecord[]
  removedSmallRegions: number
  topologyEdits: number
}

const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const

function indexOf(x: number, y: number, width: number): number {
  return y * width + x
}

function isActive(index: number, activeMask?: Uint8Array): boolean {
  return activeMask === undefined || activeMask[index] === 1
}

function collectComponent(
  colorIds: readonly string[],
  width: number,
  height: number,
  start: number,
  visited: Uint8Array,
  activeMask?: Uint8Array,
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
      if (isActive(next, activeMask) && visited[next] === 0 && colorIds[next] === colorId) {
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
  activeMask?: Uint8Array,
): { colorId: string; support: number } | undefined {
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
      if (componentSet.has(next) || isActive(next, activeMask) === false) continue
      const colorId = colorIds[next]
      if (colorId !== undefined) counts.set(colorId, (counts.get(colorId) ?? 0) + 1)
    }
  }
  const selected = [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]
  return selected === undefined ? undefined : { colorId: selected[0], support: selected[1] }
}

export function optimizeGrid(
  inputColorIds: readonly string[],
  width: number,
  height: number,
  protectedCells: ReadonlySet<number>,
  options: OptimizationOptions = {},
  activeMask?: Uint8Array,
): GridOptimizationResult {
  const sourceColorIds = [...inputColorIds]
  const colorIds = [...inputColorIds]
  const edits: GridEditRecord[] = []
  const pendingEdits: GridEditRecord[] = []
  const minimumRegionSize = Math.max(1, Math.floor(options.minRegionSize ?? 2))
  const isolatedPixelPenalty = Math.max(0, options.isolatedPixelPenalty ?? 1)
  const visited = new Uint8Array(colorIds.length)
  let removedSmallRegions = 0
  let topologyEdits = 0
  for (let start = 0; start < colorIds.length; start += 1) {
    if (visited[start] === 1) continue
    if (isActive(start, activeMask) === false) {
      visited[start] = 1
      continue
    }
    const component = collectComponent(sourceColorIds, width, height, start, visited, activeMask)
    if (component.length >= minimumRegionSize || component.some((cell) => protectedCells.has(cell))) continue
    const replacement = chooseNeighborColor(sourceColorIds, width, height, component, activeMask)
    if (replacement === undefined || replacement.colorId === sourceColorIds[start]
      || isolatedPixelPenalty * replacement.support <= component.length) continue
    removedSmallRegions += 1
    for (const cell of component) {
      pendingEdits.push({
        x: cell % width,
        y: Math.floor(cell / width),
        fromColorId: sourceColorIds[cell]!,
        toColorId: replacement.colorId,
        reason: component.length === 1 ? 'isolated-cell' : 'small-region',
      })
    }
  }
  for (const edit of pendingEdits) {
    colorIds[indexOf(edit.x, edit.y, width)] = edit.toColorId
    edits.push(edit)
  }
  if ((options.stripePenalty ?? 0) > 0) {
    const stripePenalty = Math.max(0, options.stripePenalty ?? 0)
    const snapshot = [...colorIds]
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const current = indexOf(x, y, width)
        const leftIndex = indexOf(x - 1, y, width)
        const rightIndex = indexOf(x + 1, y, width)
        const topIndex = indexOf(x, y - 1, width)
        const bottomIndex = indexOf(x, y + 1, width)
        if (protectedCells.has(current)
          || [current, leftIndex, rightIndex, topIndex, bottomIndex]
            .some((index) => isActive(index, activeMask) === false)) continue
        const left = snapshot[leftIndex]
        const right = snapshot[rightIndex]
        const top = snapshot[topIndex]
        const bottom = snapshot[bottomIndex]
        const horizontal = left === right && left !== snapshot[current] ? left : undefined
        const vertical = top === bottom && top !== snapshot[current] ? top : undefined
        const candidates = new Map<string, number>()
        if (horizontal !== undefined) candidates.set(horizontal, 1)
        if (vertical !== undefined) candidates.set(vertical, (candidates.get(vertical) ?? 0) + 1)
        const replacement = [...candidates.entries()]
          .filter((entry) => stripePenalty * entry[1] > 0.5)
          .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]
        if (replacement !== undefined) {
          const fromColorId = colorIds[current]!
          colorIds[current] = replacement[0]
          edits.push({ x, y, fromColorId, toColorId: replacement[0], reason: 'stripe' })
        }
      }
    }
  }
  if ((options.aliasPenalty ?? 0) > 0) {
    const aliasPenalty = Math.max(0, options.aliasPenalty ?? 0)
    const snapshot = [...colorIds]
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const current = indexOf(x, y, width)
        if (protectedCells.has(current) || isActive(current, activeMask) === false) continue
        const counts = new Map<string, number>()
        let matchingOrthogonal = 0
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) continue
            const next = indexOf(x + offsetX, y + offsetY, width)
            if (isActive(next, activeMask) === false) continue
            const colorId = snapshot[next]!
            counts.set(colorId, (counts.get(colorId) ?? 0) + 1)
            if (Math.abs(offsetX) + Math.abs(offsetY) === 1 && colorId === snapshot[current]) {
              matchingOrthogonal += 1
            }
          }
        }
        const dominant = [...counts.entries()]
          .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]
        const currentSupport = counts.get(snapshot[current]!) ?? 0
        if (dominant === undefined || dominant[0] === snapshot[current]
          || dominant[1] < 6 || matchingOrthogonal > 1
          || aliasPenalty * (dominant[1] - currentSupport) <= 1) continue
        const fromColorId = colorIds[current]!
        colorIds[current] = dominant[0]
        edits.push({ x, y, fromColorId, toColorId: dominant[0], reason: 'topology' })
        topologyEdits += 1
      }
    }
  }
  return { colorIds, edits, removedSmallRegions, topologyEdits }
}

export function countIsolatedCells(
  colorIds: readonly string[],
  width: number,
  height: number,
  activeMask?: Uint8Array,
): number {
  let isolated = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const currentIndex = indexOf(x, y, width)
      if (isActive(currentIndex, activeMask) === false) continue
      const current = colorIds[currentIndex]
      let matches = 0
      for (const [offsetX, offsetY] of neighbors) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height) {
          const next = indexOf(nextX, nextY, width)
          if (isActive(next, activeMask) && colorIds[next] === current) matches += 1
        }
      }
      if (matches === 0) isolated += 1
    }
  }
  return isolated
}

export function countThinStripes(
  colorIds: readonly string[],
  width: number,
  height: number,
  activeMask?: Uint8Array,
): number {
  let stripes = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const currentIndex = indexOf(x, y, width)
      const leftIndex = indexOf(x - 1, y, width)
      const rightIndex = indexOf(x + 1, y, width)
      const topIndex = indexOf(x, y - 1, width)
      const bottomIndex = indexOf(x, y + 1, width)
      if ([currentIndex, leftIndex, rightIndex, topIndex, bottomIndex]
        .some((index) => isActive(index, activeMask) === false)) continue
      const current = colorIds[currentIndex]
      const horizontal = colorIds[leftIndex] === colorIds[rightIndex]
        && colorIds[leftIndex] !== current
      const vertical = colorIds[topIndex] === colorIds[bottomIndex]
        && colorIds[topIndex] !== current
      if (horizontal || vertical) stripes += 1
    }
  }
  return stripes
}
