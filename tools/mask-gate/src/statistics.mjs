export function wilsonInterval(count, total, z = 1.959963984540054) {
  if (Number.isInteger(count) === false || Number.isInteger(total) === false
    || count < 0 || total < 0 || count > total) {
    throw new RangeError('count and total must be valid non-negative sample counts')
  }
  if (Number.isFinite(z) === false || z <= 0) throw new RangeError('z must be positive')
  if (total === 0) return { lower: null, upper: null }
  const proportion = count / total
  const zSquared = z * z
  const denominator = 1 + zSquared / total
  const center = (proportion + zSquared / (2 * total)) / denominator
  const radius = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total,
  ) / denominator
  return {
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
  }
}

