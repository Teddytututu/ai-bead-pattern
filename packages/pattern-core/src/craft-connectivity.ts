export interface OrthogonalConnectivityLink {
  start: number
  end: number
  componentId: number
}

export interface OrthogonalConnectivityInput {
  width: number
  height: number
  values: ArrayLike<number>
  links: readonly OrthogonalConnectivityLink[]
  holeReference?: ArrayLike<number>
  componentOwners?: ArrayLike<number>
}

export interface OrthogonalConnectivityResult {
  mask: Uint8Array
  addedCells: readonly number[]
  bridgeEndpointCells: readonly number[]
  fragileBridgeCells: readonly number[]
  fourConnectedComponentsBefore: number
  fourConnectedComponentsAfter: number
  eightConnectedComponentsBefore: number
  eightConnectedComponentsAfter: number
  holesBefore: number
  holesAfter: number
  rejectedLinks: number
  bridgeReuseCount: number
  simplePointRejections: number
  topologyRejections: number
  holeRejections: number
  ownerRejections: number
}

const fourNeighborOffsets = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const

const eightNeighborOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

interface ComponentLabels {
  labels: Int32Array
  count: number
}

interface HoleAnalysis {
  mask: Uint8Array
  count: number
}

interface BridgeCandidate {
  link: OrthogonalConnectivityLink
  path: readonly number[]
  addedCells: readonly number[]
  fourComponentReduction: number
  resolvedLinkCount: number
  localSupportScore: number
  directedSide: number
}

interface PathTopologyAssessment {
  rejection?: 'simple-point' | 'topology'
  fourComponents?: ComponentLabels
}

function validateMask(values: ArrayLike<number>, width: number, height: number, label: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`${label} dimensions must be positive integers`)
  }
  if (values.length !== width * height) throw new RangeError(`${label} dimensions must align`)
}

function binaryMask(values: ArrayLike<number>): Uint8Array {
  return Uint8Array.from(values, (value) => Number(Number(value) >= 0.5))
}

function labelComponents(
  values: Uint8Array,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): ComponentLabels {
  const labels = new Int32Array(values.length)
  labels.fill(-1)
  let count = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 0 || labels[start] !== -1) continue
    labels[start] = count
    const queue = [start]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      const x = cell % width
      const y = Math.floor(cell / width)
      for (const [offsetX, offsetY] of offsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 0 || labels[next] !== -1) continue
        labels[next] = count
        queue.push(next)
      }
    }
    count += 1
  }
  return { labels, count }
}

function analyzeFourConnectedHoles(
  values: Uint8Array,
  width: number,
  height: number,
): HoleAnalysis {
  const visited = new Uint8Array(values.length)
  const holes = new Uint8Array(values.length)
  let count = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 1 || visited[start] === 1) continue
    const cells: number[] = []
    const queue = [start]
    visited[start] = 1
    let touchesBorder = false
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      cells.push(cell)
      const x = cell % width
      const y = Math.floor(cell / width)
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [offsetX, offsetY] of fourNeighborOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 1 || visited[next] === 1) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (touchesBorder) continue
    count += 1
    for (const cell of cells) holes[cell] = 1
  }
  return { mask: holes, count }
}

function pathKey(path: readonly number[]): string {
  return path.join(',')
}

function orthogonalPath(
  start: number,
  end: number,
  width: number,
  horizontalOnTie: boolean,
): readonly number[] {
  let x = start % width
  let y = Math.floor(start / width)
  const endX = end % width
  const endY = Math.floor(end / width)
  const deltaX = Math.abs(endX - x)
  const deltaY = Math.abs(endY - y)
  const stepX = x < endX ? 1 : -1
  const stepY = y < endY ? 1 : -1
  let horizontalSteps = 0
  let verticalSteps = 0
  const path = [start]
  while (x !== endX || y !== endY) {
    const canStepX = x !== endX
    const canStepY = y !== endY
    const nextHorizontalProgress = deltaX === 0
      ? Number.POSITIVE_INFINITY
      : (horizontalSteps + 1) / deltaX
    const nextVerticalProgress = deltaY === 0
      ? Number.POSITIVE_INFINITY
      : (verticalSteps + 1) / deltaY
    const horizontalFirst = nextHorizontalProgress < nextVerticalProgress
      || (horizontalOnTie && nextHorizontalProgress === nextVerticalProgress)
    if (canStepX && (canStepY === false || horizontalFirst)) {
      x += stepX
      horizontalSteps += 1
    } else {
      y += stepY
      verticalSteps += 1
    }
    path.push(y * width + x)
  }
  return path
}

function candidatePaths(
  link: OrthogonalConnectivityLink,
  width: number,
): readonly (readonly number[])[] {
  const first = orthogonalPath(link.start, link.end, width, true)
  const second = orthogonalPath(link.start, link.end, width, false)
  return pathKey(first) === pathKey(second) ? [first] : [first, second]
}

function directedPathSide(
  link: OrthogonalConnectivityLink,
  path: readonly number[],
  width: number,
): number {
  const startX = link.start % width
  const startY = Math.floor(link.start / width)
  const deltaX = link.end % width - startX
  const deltaY = Math.floor(link.end / width) - startY
  for (const cell of path.slice(1, -1)) {
    const offsetX = cell % width - startX
    const offsetY = Math.floor(cell / width) - startY
    const cross = deltaX * offsetY - deltaY * offsetX
    if (cross !== 0) return Math.sign(cross)
  }
  return 0
}

function localConnectivityCount(
  mask: Uint8Array,
  center: number,
  width: number,
  height: number,
  foreground: boolean,
  offsets: readonly (readonly [number, number])[],
  centerAdjacentOffsets?: readonly (readonly [number, number])[],
): number {
  const local = new Uint8Array(9)
  const centerX = center % width
  const centerY = Math.floor(center / width)
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      const x = centerX + offsetX
      const y = centerY + offsetY
      const localCell = (offsetY + 1) * 3 + offsetX + 1
      if (x < 0 || y < 0 || x >= width || y >= height) {
        local[localCell] = Number(foreground === false)
        continue
      }
      local[localCell] = Number(foreground ? mask[y * width + x] === 1 : mask[y * width + x] === 0)
    }
  }
  const labeled = labelComponents(local, 3, 3, offsets)
  if (centerAdjacentOffsets === undefined) return labeled.count
  const adjacentLabels = new Set<number>()
  for (const [offsetX, offsetY] of centerAdjacentOffsets) {
    const label = labeled.labels[(offsetY + 1) * 3 + offsetX + 1] ?? -1
    if (label >= 0) adjacentLabels.add(label)
  }
  return adjacentLabels.size
}

function isSimpleForegroundAddition(
  mask: Uint8Array,
  cell: number,
  width: number,
  height: number,
): boolean {
  if (mask[cell] === 1) return true
  return localConnectivityCount(mask, cell, width, height, true, eightNeighborOffsets) === 1
    && localConnectivityCount(
      mask,
      cell,
      width,
      height,
      false,
      fourNeighborOffsets,
      fourNeighborOffsets,
    ) === 1
}

function assessPathTopology(
  mask: Uint8Array,
  path: readonly number[],
  width: number,
  height: number,
  eightComponents: number,
  holes: number,
): PathTopologyAssessment {
  const changed: number[] = []
  for (const cell of path) {
    if (mask[cell] === 1) continue
    if (!isSimpleForegroundAddition(mask, cell, width, height)) {
      for (const changedCell of changed) mask[changedCell] = 0
      return { rejection: 'simple-point' }
    }
    mask[cell] = 1
    changed.push(cell)
  }
  const preserved = labelComponents(mask, width, height, eightNeighborOffsets).count === eightComponents
    && analyzeFourConnectedHoles(mask, width, height).count === holes
  const fourComponents = preserved
    ? labelComponents(mask, width, height, fourNeighborOffsets)
    : undefined
  for (const cell of changed) mask[cell] = 0
  if (!preserved || fourComponents === undefined) return { rejection: 'topology' }
  return { fourComponents }
}

function compareNumberArrays(first: readonly number[], second: readonly number[]): number {
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    if (first[index] !== second[index]) return first[index]! - second[index]!
  }
  return first.length - second.length
}

function canonicalCellTransform(
  values: Uint8Array,
  width: number,
  height: number,
): (cell: number) => number {
  const transforms: Array<(cell: number) => number> = [
    (cell) => cell,
    (cell) => {
      const x = cell % width
      const y = Math.floor(cell / width)
      return (height - 1 - y) * width + width - 1 - x
    },
    (cell) => {
      const x = cell % width
      const y = Math.floor(cell / width)
      return y * width + width - 1 - x
    },
    (cell) => {
      const x = cell % width
      const y = Math.floor(cell / width)
      return (height - 1 - y) * width + x
    },
  ]
  if (width === height) {
    transforms.push(
      (cell) => {
        const x = cell % width
        const y = Math.floor(cell / width)
        return x * width + width - 1 - y
      },
      (cell) => {
        const x = cell % width
        const y = Math.floor(cell / width)
        return (width - 1 - x) * width + y
      },
      (cell) => {
        const x = cell % width
        const y = Math.floor(cell / width)
        return x * width + y
      },
      (cell) => {
        const x = cell % width
        const y = Math.floor(cell / width)
        return (width - 1 - x) * width + width - 1 - y
      },
    )
  }
  const occupied = [...values.keys()].filter((cell) => values[cell] === 1)
  let selected = transforms[0]!
  let selectedKey = occupied.map(selected).sort((first, second) => first - second)
  for (const transform of transforms.slice(1)) {
    const key = occupied.map(transform).sort((first, second) => first - second)
    if (compareNumberArrays(key, selectedKey) >= 0) continue
    selected = transform
    selectedKey = key
  }
  return selected
}

function articulationMask(values: Uint8Array, width: number, height: number): Uint8Array {
  const discovery = new Int32Array(values.length)
  const low = new Int32Array(values.length)
  const parent = new Int32Array(values.length)
  const childCount = new Int32Array(values.length)
  const articulation = new Uint8Array(values.length)
  discovery.fill(-1)
  parent.fill(-1)
  let time = 0

  for (let root = 0; root < values.length; root += 1) {
    if (values[root] === 0 || discovery[root] !== -1) continue
    discovery[root] = time
    low[root] = time
    time += 1
    const nodes = [root]
    const nextOffsets = [0]
    while (nodes.length > 0) {
      const depth = nodes.length - 1
      const node = nodes[depth]!
      const offsetIndex = nextOffsets[depth]!
      if (offsetIndex < fourNeighborOffsets.length) {
        nextOffsets[depth] = offsetIndex + 1
        const [offsetX, offsetY] = fourNeighborOffsets[offsetIndex]!
        const x = node % width + offsetX
        const y = Math.floor(node / width) + offsetY
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const next = y * width + x
        if (values[next] === 0) continue
        if (discovery[next] === -1) {
          parent[next] = node
          childCount[node] = (childCount[node] ?? 0) + 1
          discovery[next] = time
          low[next] = time
          time += 1
          nodes.push(next)
          nextOffsets.push(0)
          continue
        }
        if (next !== parent[node]) low[node] = Math.min(low[node]!, discovery[next]!)
        continue
      }

      nodes.pop()
      nextOffsets.pop()
      const parentNode = parent[node]!
      if (parentNode < 0) {
        if (childCount[node]! > 1) articulation[node] = 1
        continue
      }
      low[parentNode] = Math.min(low[parentNode]!, low[node]!)
      if (parent[parentNode]! >= 0 && low[node]! >= discovery[parentNode]!) {
        articulation[parentNode] = 1
      }
    }
  }
  return articulation
}

export function fragileOrthogonalCells(
  values: ArrayLike<number>,
  width: number,
  height: number,
  candidateCells: readonly number[],
): readonly number[] {
  validateMask(values, width, height, 'Orthogonal fragility mask')
  const mask = binaryMask(values)
  const articulation = articulationMask(mask, width, height)
  const unique = new Set<number>()
  for (const cell of candidateCells) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= mask.length) {
      throw new RangeError('Orthogonal fragility candidates must stay inside the mask')
    }
    if (mask[cell] === 1 && articulation[cell] === 1) unique.add(cell)
  }
  return [...unique].sort((first, second) => first - second)
}

function uniqueLinks(
  links: readonly OrthogonalConnectivityLink[],
  maskLength: number,
): readonly OrthogonalConnectivityLink[] {
  const unique = new Map<string, OrthogonalConnectivityLink>()
  for (const link of links) {
    if (!Number.isInteger(link.start) || !Number.isInteger(link.end)
      || link.start < 0 || link.end < 0 || link.start >= maskLength || link.end >= maskLength) {
      throw new RangeError('Orthogonal connectivity link endpoints must stay inside the mask')
    }
    if (!Number.isInteger(link.componentId) || link.componentId < 0) {
      throw new RangeError('Orthogonal connectivity component ids must be non-negative integers')
    }
    const minimum = Math.min(link.start, link.end)
    const maximum = Math.max(link.start, link.end)
    unique.set(`${link.componentId}:${minimum}:${maximum}`, link)
  }
  return [...unique.values()].sort((first, second) => first.componentId - second.componentId
    || Math.min(first.start, first.end) - Math.min(second.start, second.end)
    || Math.max(first.start, first.end) - Math.max(second.start, second.end))
}

function normalizedLinkKey(link: OrthogonalConnectivityLink): string {
  return `${link.componentId}:${Math.min(link.start, link.end)}:${Math.max(link.start, link.end)}`
}

function candidateKey(link: OrthogonalConnectivityLink, path: readonly number[]): string {
  return `${normalizedLinkKey(link)}:${pathKey(path)}`
}

function touchesAnotherOwner(
  cell: number,
  componentId: number,
  owners: Int32Array,
  mask: Uint8Array,
  width: number,
  height: number,
): boolean {
  const x = cell % width
  const y = Math.floor(cell / width)
  return fourNeighborOffsets.some(([offsetX, offsetY]) => {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) return false
    const next = nextY * width + nextX
    const owner = owners[next] ?? -1
    return mask[next] === 1 && owner >= 0 && owner !== componentId
  })
}

interface RejectionSets {
  owner: Set<string>
  hole: Set<string>
  simplePoint: Set<string>
  topology: Set<string>
}

interface BridgeTransaction {
  mask: Uint8Array
  owners: Int32Array
  addedCells: readonly number[]
  endpointCells: readonly number[]
  reuseCount: number
}

const exactBridgeCombinationLimit = 65_535

function orthogonalSupportScore(
  baseMask: Uint8Array,
  addedCells: readonly number[],
  width: number,
  height: number,
): number {
  const mask = baseMask.slice()
  for (const cell of addedCells) mask[cell] = 1
  let score = 0
  for (const cell of addedCells) {
    const x = cell % width
    const y = Math.floor(cell / width)
    let neighbors = 0
    for (const [offsetX, offsetY] of fourNeighborOffsets) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
      neighbors += mask[nextY * width + nextX] ?? 0
    }
    score += neighbors * neighbors
  }
  return score
}

function compareBridgeCandidates(first: BridgeCandidate, second: BridgeCandidate): number {
  return (
    second.resolvedLinkCount * first.addedCells.length
    - first.resolvedLinkCount * second.addedCells.length
  ) || (
    second.fourComponentReduction * first.addedCells.length
    - first.fourComponentReduction * second.addedCells.length
  )
    || second.resolvedLinkCount - first.resolvedLinkCount
    || second.fourComponentReduction - first.fourComponentReduction
    || first.addedCells.length - second.addedCells.length
    || second.localSupportScore - first.localSupportScore
    || first.directedSide - second.directedSide
    || first.link.componentId - second.link.componentId
    || compareNumberArrays(first.path, second.path)
}

function linkIsConnected(
  link: OrthogonalConnectivityLink,
  components: ComponentLabels,
): boolean {
  const start = components.labels[link.start] ?? -1
  const end = components.labels[link.end] ?? -1
  return start >= 0 && start === end
}

function collectBridgeCandidates(
  mask: Uint8Array,
  links: readonly OrthogonalConnectivityLink[],
  allLinks: readonly OrthogonalConnectivityLink[],
  owners: Int32Array,
  reservedHoles: HoleAnalysis,
  width: number,
  height: number,
  rejections: RejectionSets,
  allowCollectiveTopology = false,
): ReadonlyMap<OrthogonalConnectivityLink, readonly BridgeCandidate[]> {
  const components = labelComponents(mask, width, height, fourNeighborOffsets)
  const eightComponents = labelComponents(mask, width, height, eightNeighborOffsets).count
  const holes = analyzeFourConnectedHoles(mask, width, height).count
  const byLink = new Map<OrthogonalConnectivityLink, readonly BridgeCandidate[]>()
  for (const link of links) {
    const candidates: BridgeCandidate[] = []
    if (mask[link.start] === 0 || mask[link.end] === 0 || linkIsConnected(link, components)) {
      byLink.set(link, candidates)
      continue
    }
    for (const path of candidatePaths(link, width)) {
      const key = candidateKey(link, path)
      const addedCells: number[] = []
      let valid = true
      for (const cell of path) {
        const owner = owners[cell] ?? -1
        if (owner >= 0 && owner !== link.componentId) {
          rejections.owner.add(key)
          valid = false
          break
        }
        if (mask[cell] === 1) continue
        if (touchesAnotherOwner(cell, link.componentId, owners, mask, width, height)) {
          rejections.owner.add(key)
          valid = false
          break
        }
        if (reservedHoles.mask[cell] === 1) {
          rejections.hole.add(key)
          valid = false
          break
        }
        addedCells.push(cell)
      }
      if (!valid || addedCells.length === 0) continue
      let simulated: ComponentLabels
      if (allowCollectiveTopology) {
        const simulatedMask = mask.slice()
        for (const cell of addedCells) simulatedMask[cell] = 1
        simulated = labelComponents(simulatedMask, width, height, fourNeighborOffsets)
      } else {
        const topology = assessPathTopology(
          mask,
          path,
          width,
          height,
          eightComponents,
          holes,
        )
        if (topology.rejection !== undefined) {
          if (topology.rejection === 'simple-point') rejections.simplePoint.add(key)
          else rejections.topology.add(key)
          continue
        }
        simulated = topology.fourComponents!
      }
      const resolvedLinkCount = allLinks.reduce((sum, candidateLink) => {
        if (linkIsConnected(candidateLink, components)) return sum
        return sum + Number(linkIsConnected(candidateLink, simulated))
      }, 0)
      candidates.push({
        link,
        path,
        addedCells,
        fourComponentReduction: components.count - simulated.count,
        resolvedLinkCount,
        localSupportScore: orthogonalSupportScore(mask, addedCells, width, height),
        directedSide: directedPathSide(link, path, width),
      })
    }
    candidates.sort(compareBridgeCandidates)
    byLink.set(link, candidates)
  }
  return byLink
}

function transactionIsValid(
  baseMask: Uint8Array,
  addedCells: readonly number[],
  requiredLinks: readonly OrthogonalConnectivityLink[],
  width: number,
  height: number,
): Uint8Array | undefined {
  const mask = baseMask.slice()
  for (const cell of addedCells) mask[cell] = 1
  const baseEightComponents = labelComponents(
    baseMask,
    width,
    height,
    eightNeighborOffsets,
  ).count
  if (labelComponents(mask, width, height, eightNeighborOffsets).count !== baseEightComponents) {
    return undefined
  }
  const baseHoles = analyzeFourConnectedHoles(baseMask, width, height).count
  if (analyzeFourConnectedHoles(mask, width, height).count !== baseHoles) return undefined
  const components = labelComponents(mask, width, height, fourNeighborOffsets)
  if (requiredLinks.some((link) => !linkIsConnected(link, components))) return undefined
  return mask
}

function exactBridgeTransaction(
  mask: Uint8Array,
  owners: Int32Array,
  requiredLinks: readonly OrthogonalConnectivityLink[],
  allLinks: readonly OrthogonalConnectivityLink[],
  reservedHoles: HoleAnalysis,
  width: number,
  height: number,
  rejections: RejectionSets,
): BridgeTransaction | undefined {
  const candidatesByLink = collectBridgeCandidates(
    mask,
    requiredLinks,
    allLinks,
    owners,
    reservedHoles,
    width,
    height,
    rejections,
    true,
  )
  if (requiredLinks.some((link) => (candidatesByLink.get(link)?.length ?? 0) === 0)) {
    return undefined
  }
  const candidateCells: number[] = []
  const seenCells = new Set<number>()
  for (const link of requiredLinks) {
    for (const candidate of candidatesByLink.get(link) ?? []) {
      for (const cell of candidate.addedCells) {
        if (seenCells.has(cell)) continue
        seenCells.add(cell)
        candidateCells.push(cell)
      }
    }
  }
  const combinationCount = 2 ** candidateCells.length - 1
  if (candidateCells.length === 0 || combinationCount > exactBridgeCombinationLimit) return undefined

  let selectedMask: Uint8Array | undefined
  let selectedCells: readonly number[] | undefined
  let selectedCanonicalCells: readonly number[] | undefined
  let selectedSupportScore = Number.NEGATIVE_INFINITY
  const canonicalTransform = canonicalCellTransform(mask, width, height)
  const selection: number[] = []
  const search = (start: number, remaining: number): void => {
    if (remaining === 0) {
      const cells = selection.map((index) => candidateCells[index]!)
      const candidateMask = transactionIsValid(mask, cells, requiredLinks, width, height)
      if (candidateMask === undefined) return
      const supportScore = orthogonalSupportScore(mask, cells, width, height)
      const canonicalCells = cells.map(canonicalTransform).sort((first, second) => first - second)
      if (supportScore > selectedSupportScore
        || (supportScore === selectedSupportScore
          && requiredLinks.length > 1
          && selectedCanonicalCells !== undefined
          && compareNumberArrays(canonicalCells, selectedCanonicalCells) < 0)) {
        selectedMask = candidateMask
        selectedCells = cells
        selectedCanonicalCells = canonicalCells
        selectedSupportScore = supportScore
      }
      return
    }
    for (let index = start; index <= candidateCells.length - remaining; index += 1) {
      selection.push(index)
      search(index + 1, remaining - 1)
      selection.pop()
    }
  }
  for (let count = 1; count <= candidateCells.length; count += 1) {
    search(0, count)
    if (selectedMask !== undefined) break
  }
  if (selectedMask === undefined || selectedCells === undefined) return undefined
  const transactionOwners = owners.slice()
  for (const cell of selectedCells) {
    if (transactionOwners[cell] === -1) transactionOwners[cell] = requiredLinks[0]!.componentId
  }
  return {
    mask: selectedMask,
    owners: transactionOwners,
    addedCells: selectedCells,
    endpointCells: [...new Set(requiredLinks.flatMap((link) => [link.start, link.end]))],
    reuseCount: Math.max(0, requiredLinks.length - selectedCells.length),
  }
}

function greedyBridgeTransaction(
  baseMask: Uint8Array,
  baseOwners: Int32Array,
  requiredLinks: readonly OrthogonalConnectivityLink[],
  allLinks: readonly OrthogonalConnectivityLink[],
  reservedHoles: HoleAnalysis,
  width: number,
  height: number,
  rejections: RejectionSets,
): BridgeTransaction | undefined {
  const mask = baseMask.slice()
  const owners = baseOwners.slice()
  const added = new Set<number>()
  const chosenLinks = new Set<OrthogonalConnectivityLink>()
  while (true) {
    const components = labelComponents(mask, width, height, fourNeighborOffsets)
    const unresolved = requiredLinks.filter((link) => !linkIsConnected(link, components))
    if (unresolved.length === 0) break
    const candidatesByLink = collectBridgeCandidates(
      mask,
      unresolved,
      allLinks,
      owners,
      reservedHoles,
      width,
      height,
      rejections,
    )
    const candidates = unresolved.flatMap((link) => candidatesByLink.get(link) ?? [])
    candidates.sort(compareBridgeCandidates)
    const chosen = candidates[0]
    if (chosen === undefined) return undefined
    chosenLinks.add(chosen.link)
    for (const cell of chosen.path) {
      if (mask[cell] === 0) {
        mask[cell] = 1
        added.add(cell)
      }
      if (owners[cell] === -1) owners[cell] = chosen.link.componentId
    }
  }
  const addedCells = [...added]
  const validatedMask = transactionIsValid(
    baseMask,
    addedCells,
    requiredLinks,
    width,
    height,
  )
  if (validatedMask === undefined) return undefined
  return {
    mask: validatedMask,
    owners,
    addedCells,
    endpointCells: [...new Set(requiredLinks.flatMap((link) => [link.start, link.end]))],
    reuseCount: requiredLinks.filter((link) => !chosenLinks.has(link)).length,
  }
}

/**
 * Adds a minimum-cost orthogonal support path only when a known same-component
 * link still spans separate F4 craft components. H4 hole cells stay reserved.
 */
export function bridgeOrthogonalLinks(
  input: OrthogonalConnectivityInput,
): OrthogonalConnectivityResult {
  const { width, height } = input
  validateMask(input.values, width, height, 'Orthogonal connectivity mask')
  if (input.holeReference !== undefined) {
    validateMask(input.holeReference, width, height, 'Orthogonal connectivity hole reference')
  }
  if (input.componentOwners !== undefined) {
    validateMask(input.componentOwners, width, height, 'Orthogonal connectivity owners')
  }
  const mask = binaryMask(input.values)
  const holeReference = binaryMask(input.holeReference ?? input.values)
  const reservedHoles = input.holeReference === undefined
    ? { mask: new Uint8Array(mask.length), count: 0 }
    : analyzeFourConnectedHoles(holeReference, width, height)
  const holesBefore = analyzeFourConnectedHoles(mask, width, height).count
  const fourBefore = labelComponents(mask, width, height, fourNeighborOffsets)
  const eightBefore = labelComponents(mask, width, height, eightNeighborOffsets)
  const owners = new Int32Array(mask.length)
  owners.fill(-1)
  if (input.componentOwners !== undefined) {
    for (let index = 0; index < owners.length; index += 1) {
      const owner = Number(input.componentOwners[index] ?? -1)
      if (!Number.isFinite(owner) || !Number.isInteger(owner) || owner < -1) {
        throw new RangeError('Orthogonal connectivity owners must contain -1 or non-negative integers')
      }
      owners[index] = owner
    }
  }
  const links = uniqueLinks(input.links, mask.length)
  for (const link of links) {
    if (owners[link.start] === -1) owners[link.start] = link.componentId
    if (owners[link.end] === -1) owners[link.end] = link.componentId
  }
  const rejections: RejectionSets = {
    owner: new Set<string>(),
    hole: new Set<string>(),
    simplePoint: new Set<string>(),
    topology: new Set<string>(),
  }
  const added = new Set<number>()
  const bridgeEndpoints = new Set<number>()
  let bridgeReuseCount = 0
  const linksByComponent = new Map<number, OrthogonalConnectivityLink[]>()
  for (const link of links) {
    const group = linksByComponent.get(link.componentId) ?? []
    group.push(link)
    linksByComponent.set(link.componentId, group)
  }
  for (const group of linksByComponent.values()) {
    const components = labelComponents(mask, width, height, fourNeighborOffsets)
    const requiredLinks = group.filter((link) => mask[link.start] === 1
      && mask[link.end] === 1
      && !linkIsConnected(link, components))
    if (requiredLinks.length === 0) continue
    const transaction = exactBridgeTransaction(
      mask,
      owners,
      requiredLinks,
      group,
      reservedHoles,
      width,
      height,
      rejections,
    ) ?? greedyBridgeTransaction(
      mask,
      owners,
      requiredLinks,
      group,
      reservedHoles,
      width,
      height,
      rejections,
    )
    if (transaction === undefined) continue
    mask.set(transaction.mask)
    owners.set(transaction.owners)
    for (const cell of transaction.addedCells) added.add(cell)
    for (const cell of transaction.endpointCells) bridgeEndpoints.add(cell)
    bridgeReuseCount += transaction.reuseCount
  }

  const fourAfter = labelComponents(mask, width, height, fourNeighborOffsets)
  const eightAfter = labelComponents(mask, width, height, eightNeighborOffsets)
  const addedCells = [...added].sort((first, second) => first - second)
  const bridgeEndpointCells = [...bridgeEndpoints].sort((first, second) => first - second)
  const rejectedLinks = links.filter((link) => !linkIsConnected(link, fourAfter)).length
  return {
    mask,
    addedCells,
    bridgeEndpointCells,
    fragileBridgeCells: fragileOrthogonalCells(mask, width, height, addedCells),
    fourConnectedComponentsBefore: fourBefore.count,
    fourConnectedComponentsAfter: fourAfter.count,
    eightConnectedComponentsBefore: eightBefore.count,
    eightConnectedComponentsAfter: eightAfter.count,
    holesBefore,
    holesAfter: analyzeFourConnectedHoles(mask, width, height).count,
    rejectedLinks,
    bridgeReuseCount,
    simplePointRejections: rejections.simplePoint.size,
    topologyRejections: rejections.topology.size,
    holeRejections: rejections.hole.size,
    ownerRejections: rejections.owner.size,
  }
}
