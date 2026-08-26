function csv(value) {
  const source = value === undefined ? '' : String(value)
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source
}

function rows(header, values) {
  return `${[header, ...values.map((row) => row.map(csv).join(','))].join('\n')}\n`
}

function groups(values, key) {
  const result = new Map()
  for (const value of values) {
    const groupKey = key(value)
    const entries = result.get(groupKey) ?? []
    entries.push(value)
    result.set(groupKey, entries)
  }
  return [...result.entries()].toSorted(([first], [second]) => first.localeCompare(second))
}

function resolved(record) {
  return record.outcome === 'confirmed' && record.subjectAcceptable === true
}

export function renderCategoryBreakdownCsv(interactions) {
  return rows('category,total,initialFailures,resolvedFailures,cancelledOrError',
    groups(interactions, (record) => record.category).map(([category, entries]) => [
      category,
      entries.length,
      entries.filter((record) => record.initialSubjectAcceptable === false).length,
      entries.filter(resolved).length,
      entries.filter((record) => record.outcome === 'cancelled' || record.outcome === 'error').length,
    ]))
}

export function renderFailureTagBreakdownCsv(interactions) {
  const expanded = interactions.flatMap((record) =>
    record.failureTags.map((failureTag) => ({ ...record, failureTag })))
  return rows('failureTag,total,initialFailures,resolvedFailures',
    groups(expanded, (record) => record.failureTag).map(([failureTag, entries]) => [
      failureTag,
      entries.length,
      entries.filter((record) => record.initialSubjectAcceptable === false).length,
      entries.filter(resolved).length,
    ]))
}

export function renderDeviceBreakdownCsv(interactions) {
  return rows('deviceClass,inputModality,total,initialFailures,resolvedFailures',
    groups(interactions, (record) => `${record.device.class}\0${record.device.inputModality}`)
      .map(([, entries]) => [
        entries[0].device.class,
        entries[0].device.inputModality,
        entries.length,
        entries.filter((record) => record.initialSubjectAcceptable === false).length,
        entries.filter(resolved).length,
      ]))
}

export function renderControlPreservationCsv(interactions) {
  return rows('imageId,initialAcceptable,outcome,preserved', interactions
    .filter((record) => record.cohort === 'clean-control')
    .toSorted((first, second) => first.imageId.localeCompare(second.imageId))
    .map((record) => [
      record.imageId,
      record.initialSubjectAcceptable,
      record.outcome,
      record.initialSubjectAcceptable === true && record.outcome === 'accepted',
    ]))
}
