import { deltaE2000 } from '../color.js'
import type { Lab, PatternStyle, StructureOptions, ValueMode } from '../types.js'

export function resolveValuePolicy(style: PatternStyle, options: StructureOptions): { mode: ValueMode; strength: number } {
  const mode = options.valueMode ?? (style === 'faithful' ? 'preserve' : style === 'simple' ? 'adaptive' : 'stylized')
  return { mode, strength: mode === 'preserve' ? 0 : options.valueStrength ?? 1 }
}

/** A bounded L*-only transform. a* and b* never pass through RGB clipping. */
export function boundedValueLab(source: Lab, target: number, budget: number): Lab {
  let lightness = Math.max(0, Math.min(100, Math.max(source[0] - budget, Math.min(source[0] + budget, target))))
  if (deltaE2000(source, [lightness, source[1], source[2]]) > budget) {
    let low = 0, high = 1
    for (let iteration = 0; iteration < 20; iteration++) {
      const fraction = (low + high) / 2
      const trial: Lab = [source[0] + (lightness - source[0]) * fraction, source[1], source[2]]
      if (deltaE2000(source, trial) <= budget) low = fraction
      else high = fraction
    }
    lightness = source[0] + (lightness - source[0]) * low
  }
  return [lightness, source[1], source[2]]
}
