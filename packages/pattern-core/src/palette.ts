import type { MaterialPalette } from './types.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Catalog identity excludes per-request stock and substitution constraints. */
export async function createPaletteVersion(palette: MaterialPalette): Promise<string> {
  const content = canonical({
    id: palette.id, name: palette.name, brand: palette.brand,
    rgbKind: palette.rgbKind, source: palette.source, colors: palette.colors,
  })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return `sha256:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')}`
}
