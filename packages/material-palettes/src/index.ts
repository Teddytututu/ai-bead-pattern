import { createPaletteVersion } from '../../pattern-core/dist/palette.js'
import { patternLimits } from '../../pattern-core/dist/limits.js'
import type { MaterialPalette } from '../../pattern-core/dist/types.js'
import { palettes } from './data.js'

export interface CatalogPalette extends MaterialPalette {
  version: string
  colorCount: number
  automaticColorCount: number
  groups?: Readonly<Record<string, number>>
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Palette object required')
  return value as Record<string, unknown>
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('Non-empty palette text required')
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

/** Strict catalog validation. Legacy generic-24 has no schema envelope. */
export async function parsePalette(input: unknown): Promise<CatalogPalette> {
  const value = object(structuredClone(input))
  text(value.id); text(value.name)
  if (value.schema !== undefined && (value.schema !== 'material-palette' || value.schemaVersion !== 1)) {
    throw new TypeError('Unsupported palette schema')
  }
  if (value.schema === undefined && value.id !== 'generic-24') throw new TypeError('Palette schema required')
  if (!Array.isArray(value.colors) || value.colors.length < 1 || value.colors.length > patternLimits.maxPaletteColors) {
    throw new RangeError('Palette color count exceeds limit')
  }
  if (value.colorCount !== undefined && value.colorCount !== value.colors.length) throw new RangeError('Palette count mismatch')
  const ids = new Set<string>(), codes = new Set<string>(), groups: Record<string, number> = Object.create(null)
  for (const entry of value.colors) {
    const color = object(entry)
    text(color.id); text(color.name)
    if (ids.has(color.id)) throw new RangeError('Duplicate palette id')
    ids.add(color.id)
    if (color.code !== undefined) {
      text(color.code)
      if (codes.has(color.code)) throw new RangeError('Duplicate palette code')
      codes.add(color.code)
    }
    if (value.id === 'mard-291' && color.code !== color.id) throw new RangeError('MARD id/code mismatch')
    if (value.id === 'perler-123' && (color.code !== color.id || !/^(80-\d{5}|PER\d{5})$/.test(color.id))) throw new RangeError('Perler id/code must be its official SKU')
    if (color.finish !== undefined && !['solid', 'transparent', 'glow', 'metallic', 'pearl'].includes(String(color.finish))) throw new TypeError('Invalid material finish')
    if (color.automaticMatch !== undefined && typeof color.automaticMatch !== 'boolean') throw new TypeError('Invalid automaticMatch')
    if (color.finish !== undefined && color.finish !== 'solid' && color.automaticMatch !== false) throw new RangeError('Special finishes require automaticMatch=false')
    if (!Array.isArray(color.rgb) || color.rgb.length !== 3
      || !color.rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw new RangeError('Invalid palette RGB')
    const hex = `#${color.rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`
    if (typeof color.hex !== 'string' || color.hex.toLowerCase() !== hex) throw new RangeError('Palette HEX/RGB mismatch')
    if (color.lab !== undefined && (!Array.isArray(color.lab) || color.lab.length !== 3
      || !color.lab.every(v => typeof v === 'number' && Number.isFinite(v)))) throw new RangeError('Invalid palette Lab')
    if (color.group !== undefined) {
      text(color.group)
      groups[color.group] = (groups[color.group] ?? 0) + 1
    }
  }
  if (value.groups !== undefined) {
    const declared = object(value.groups)
    if (Object.keys(declared).length !== Object.keys(groups).length
      || Object.keys(groups).some(g => declared[g] !== groups[g])) throw new RangeError('Palette group mismatch')
  }
  if (value.id === 'mard-291' && (value.colors.length !== 291 || value.groups === undefined)) throw new RangeError('MARD requires all 291 colors and groups')
  if (value.id === 'perler-123' && value.colors.length !== 123) throw new RangeError('Perler requires all 123 colors')
  const automaticColorCount = value.colors.filter(color => color.automaticMatch !== false).length
  if (automaticColorCount === 0) throw new RangeError('Palette requires automatic matching colors')
  if (value.automaticColorCount !== undefined && value.automaticColorCount !== automaticColorCount) throw new RangeError('Automatic color count mismatch')
  if (value.brand !== undefined) text(value.brand)
  if (value.rgbKind !== undefined && !['screen-reference', 'measured'].includes(String(value.rgbKind))) throw new TypeError('Invalid rgbKind')
  if (value.source !== undefined) Object.values(object(value.source)).forEach(text)
  const palette = value as unknown as CatalogPalette
  palette.version = await createPaletteVersion(palette)
  palette.colorCount = palette.colors.length
  palette.automaticColorCount = automaticColorCount
  return freeze(palette)
}

let registry: Promise<readonly CatalogPalette[]> | undefined
export async function listPalettes(): Promise<readonly CatalogPalette[]> {
  registry ??= Promise.all(palettes.map(parsePalette)).then(freeze)
  return registry
}
export async function getPalette(id = 'mard-291', version?: string): Promise<CatalogPalette> {
  const palette = (await listPalettes()).find(p => p.id === id)
  if (palette === undefined || (version !== undefined && version !== palette.version)) throw new RangeError('Unknown palette or version')
  return palette
}
