export function validateGrid(value) {
  const g = structuredClone(value)
  if (!g || !Number.isInteger(g.width) || !Number.isInteger(g.height) || g.width < 1 || g.height < 1 || g.width > 64 || g.height > 64) throw new Error('实验支持 1–64 格的完整图纸')
  if (!Array.isArray(g.colors) || !g.colors.length || g.colors.length > 291 || typeof g.paletteId !== 'string' || typeof g.paletteVersion !== 'string') throw new Error('缺少材料色卡信息')
  const ids = new Set()
  for (const color of g.colors) {
    if (typeof color.id !== 'string' || !color.id || ids.has(color.id) || !Array.isArray(color.rgb) || color.rgb.length !== 3 || color.rgb.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('材料 ID 或 RGB 不合法')
    ids.add(color.id)
  }
  if (!Array.isArray(g.cells) || g.cells.length !== g.width * g.height || g.cells.some(v => !Number.isInteger(v) || v < -1 || v >= g.colors.length)) throw new Error('格数或材料索引不合法')
  return { width: g.width, height: g.height, paletteId: g.paletteId, paletteVersion: g.paletteVersion, colors: g.colors.map(c => ({ id: c.id, rgb: c.rgb })), cells: g.cells }
}

export function importGrid(value) {
  return validateGrid(value.schema === 'bead-pattern-document-v1' ? { ...value, cells: value.grid } : value.currentGrid ?? value)
}

export function resolveSkinIndex(g, edit, locked, skinId = '') {
  if (skinId) {
    const index = g.colors.findIndex(c => c.id === skinId)
    if (index < 0) throw new Error('肤色色号不在当前色卡中')
    return index
  }
  const effective = edit.map((v, i) => v && !locked[i]), ring = new Set()
  effective.forEach((v, i) => {
    if (!v) return
    const x = i % g.width, y = Math.floor(i / g.width)
    for (let yy = Math.max(0, y - 2); yy < Math.min(g.height, y + 3); yy++) {
      for (let xx = Math.max(0, x - 2); xx < Math.min(g.width, x + 3); xx++) {
        const j = yy * g.width + xx
        if (!effective[j] && g.cells[j] >= 0) ring.add(j)
      }
    }
  })
  const context = ring.size ? [...ring] : g.cells.map((_, i) => i).filter(i => !effective[i] && g.cells[i] >= 0)
  const counts = Array(g.colors.length).fill(0)
  for (const i of context) counts[g.cells[i]]++
  return counts.indexOf(Math.max(...counts))
}

export function verifyCandidate(request, result, current) {
  if (JSON.stringify(current) !== JSON.stringify(request.currentGrid)) throw new Error('当前格图已变化，请重新生成')
  if (result.schemaVersion !== 'region-generation-v3') throw new Error('候选协议不匹配')
  if (result.decision !== 'candidate' || result.validation?.status !== 'passed') throw new Error('候选未通过填充检查')
  if (!request.contextSha256 || request.contextSha256 !== result.contextSha256) throw new Error('周边上下文未确认或已变化')
  const g = validateGrid(result.grid)
  const before = request.currentGrid
  if (g.width !== before.width || g.height !== before.height || g.paletteId !== before.paletteId || g.paletteVersion !== before.paletteVersion || JSON.stringify(g.colors) !== JSON.stringify(before.colors)) throw new Error('候选修改了坐标或材料集合')
  const changes = []
  g.cells.forEach((v, i) => {
    if (request.editMask[i] && !request.lockedMask[i] && v < 0) throw new Error('蒙版区仍有未填充格')
    if (before.cells[i] >= 0 && v < 0) throw new Error('候选删除了已有珠子')
    if (v !== before.cells[i]) {
      if (!request.editMask[i] || request.lockedMask[i]) throw new Error('候选越过编辑区或锁定区')
      changes.push({ index: i, before: before.cells[i], after: v })
    }
  })
  if (new Set(g.cells.filter(v => v >= 0)).size > request.maximumColors) throw new Error('候选超过颜色预算')
  if (!changes.length || JSON.stringify(changes) !== JSON.stringify(result.changedCells)) throw new Error('候选变更清单不匹配或未修复')
  return g
}

export function exportDocument(grid, original, audit) {
  const counts = new Map()
  for (const c of grid.cells) if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1)
  // Carry material descriptors, but never retain stale quality metrics from the input.
  const colors = grid.colors.map(c => {
    const prior = original?.colors?.find(p => p.id === c.id)
    return { ...prior, ...c, hex: '#' + c.rgb.map(v => v.toString(16).padStart(2, '0')).join('') }
  })
  return { schema: 'bead-pattern-document-v1', width: grid.width, height: grid.height,
    paletteId: grid.paletteId, paletteVersion: grid.paletteVersion, brand: original?.brand ?? 'experimental',
    colors, grid: [...grid.cells], materials: [...counts].map(([i, count]) => ({ colorId: colors[i].id, code: colors[i].code ?? colors[i].id, hex: colors[i].hex, count })),
    totalBeads: [...counts.values()].reduce((a, b) => a + b, 0),
    metadata: { regionGeneration: { schemaVersion: 'region-generation-v3', experimental: true, acceptedEdits: audit, qualityGatePassed: false } } }
}
