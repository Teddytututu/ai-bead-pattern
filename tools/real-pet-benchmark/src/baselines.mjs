/**
 * Reproducible baseline registry for the real-pet benchmark.
 *
 * PixelOE and MYOS are deliberately represented as adapters with explicit
 * provenance. The local adapters never claim to reproduce paper training or
 * weights. MYOS can be enabled with MYOS_COMMAND once its separately licensed
 * checkout and weights are installed.
 */

export const BASELINE_SCHEMA_VERSION = 'baseline-registry-v1'

export const BASELINES = Object.freeze({
  mvp: {
    id: 'mvp',
    label: 'Pattern-core MVP',
    implementationStatus: 'native',
    paperReproduction: false,
    source: 'packages/pattern-core',
    license: 'repository-license',
    description: 'Deterministic production pipeline used as the primary reference.',
    coreOptions: { baseline: 'mvp', resizeMethod: 'cell-aware' },
  },
  area: {
    id: 'area',
    label: 'Area resize',
    implementationStatus: 'native-ablation',
    paperReproduction: false,
    source: 'packages/pattern-core/src/image.ts',
    license: 'repository-license',
    description: 'Uniform area coverage quantization without learned structure planning.',
    coreOptions: { baseline: 'a1', resizeMethod: 'area' },
  },
  nearest: {
    id: 'nearest',
    label: 'Nearest resize',
    implementationStatus: 'native-ablation',
    paperReproduction: false,
    source: 'packages/pattern-core/src/image.ts',
    license: 'repository-license',
    description: 'Uniform nearest-neighbour sampling baseline.',
    coreOptions: { baseline: 'a0', resizeMethod: 'nearest' },
  },
  pixeloe: {
    id: 'pixeloe',
    label: 'PixelOE adapted heuristic',
    implementationStatus: 'adapted-heuristic',
    paperReproduction: false,
    source: 'https://github.com/KohakuBlueleaf/PixelOE',
    license: 'Apache-2.0 (upstream repository; verify model assets before redistribution)',
    description: 'Deterministic contour-aware proxy using this repository\'s outline planner; it contains no PixelOE weights or training code.',
    coreOptions: { baseline: 'mvp', resizeMethod: 'area' },
    adaptOptions: { outlineMode: 'full', shapeRefinementIterations: 3 },
  },
  myos: {
    id: 'myos',
    label: 'Make Your Own Sprites adapter',
    implementationStatus: 'external-optional',
    paperReproduction: false,
    source: 'https://github.com/WuZongWei6/Pixelization',
    license: 'Upstream terms apply; obtain permission before commercial use.',
    description: 'External adapter contract. Configure MYOS_COMMAND to a separately installed inference wrapper; local runs remain explicitly skipped until then.',
    coreOptions: null,
  },
})

export function resolveBaselineIds(value = 'mvp,area,nearest,pixeloe,myos') {
  const ids = [...new Set(String(value).split(',').map((id) => id.trim()).filter(Boolean))]
  for (const id of ids) if (!(id in BASELINES)) throw new Error(`Unknown baseline: ${id}`)
  if (ids.length === 0) throw new Error('At least one baseline is required')
  return ids
}

export function baselineStatus(id) {
  const baseline = BASELINES[id]
  if (baseline === undefined) throw new Error(`Unknown baseline: ${id}`)
  if (id === 'myos' && !process.env.MYOS_COMMAND) {
    return { ...baseline, runStatus: 'skipped', skipReason: 'MYOS_COMMAND is not configured; install the licensed upstream wrapper and set the command.' }
  }
  return { ...baseline, runStatus: 'runnable' }
}

/** Build deterministic PatternOptions for a registered native/adapted baseline. */
export function optionsForBaseline(id, { size, maxColors = 12, occupancyMode = 'subject-shape' } = {}) {
  const baseline = BASELINES[id]
  if (baseline?.coreOptions === null || baseline === undefined) return undefined
  const options = {
    canvas: { mode: 'fixed', size },
    maxColors,
    maxCandidates: 1,
    imageType: 'pet',
    styles: ['faithful'],
    baseline: baseline.coreOptions.baseline,
    resizeMethod: baseline.coreOptions.resizeMethod,
    structure: { occupancyMode, outlineMode: 'selective', shapeRefinementIterations: 2 },
  }
  if (baseline.adaptOptions !== undefined) options.structure = { ...options.structure, ...baseline.adaptOptions }
  return options
}
