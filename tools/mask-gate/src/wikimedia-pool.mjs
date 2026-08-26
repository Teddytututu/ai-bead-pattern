import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

const allowedLicenses = /^(Public domain|CC0|CC BY(?:-SA)?(?: [234]\.0)?)/i

export const wikimediaSourcePlan = Object.freeze([
  {
    category: 'portrait',
    commonsCategory: 'Portrait photographs of women',
    count: 8,
    excludeTitles: Object.freeze([
      'File:"Anasín Moanína, 11.05.20, Radolfzell, Deutschland.jpg".jpg',
    ]),
    cohortByTitle: Object.freeze({
      'File:01 portrait motion blur experimental digital photography by Rick Doble.jpg': 'extreme',
    }),
    failureTagsByTitle: Object.freeze({
      'File:01 portrait motion blur experimental digital photography by Rick Doble.jpg': ['low-detail'],
    }),
  },
  {
    category: 'portrait',
    commonsCategory: 'Portrait photographs of men',
    count: 7,
    cohortByTitle: Object.freeze({
      'File:"Qazi Syed Ghulam Usmani Social worker".jpg': 'targeted-failure',
    }),
  },
  {
    category: 'pet',
    commonsCategory: 'Portrait photographs of cats',
    count: 7,
    excludeTitles: Object.freeze([
      'File:"SVP, Je voudrais ma paté au lit !" (24240965816).jpg',
      'File:1 chat noir 04.jpg',
    ]),
  },
  {
    category: 'pet',
    commonsCategory: 'Portrait photographs of dogs',
    count: 8,
    cohortByTitle: Object.freeze({
      'File:- panoramio (3215).jpg': 'clean-control',
      'File:1898-winning-dogs 01.jpg': 'targeted-failure',
      'File:1898-winning-dogs 02.jpg': 'extreme',
    }),
    subjectCountByTitle: Object.freeze({
      'File:1898-winning-dogs 01.jpg': 8,
      'File:1898-winning-dogs 02.jpg': 12,
    }),
    failureTagsByTitle: Object.freeze({
      'File:1898-winning-dogs 01.jpg': ['multiple-subjects'],
      'File:1898-winning-dogs 02.jpg': ['multiple-subjects'],
    }),
  },
  {
    category: 'illustration',
    commonsCategory: 'SVG animals',
    count: 11,
    excludeTitles: Object.freeze([
      'File:Cambrian beasties to scale.svg',
    ]),
    subjectCountByTitle: Object.freeze({
      'File:Hasengruppe von TRAUTMANN Dresden Plauen.svg': 3,
      'File:Tadpole (PSF).svg': 4,
    }),
    cohortByTitle: Object.freeze({
      'File:Starfish Roentgen X-Ray 01 Nevit.svg': 'extreme',
      'File:דולפין ישן.svg': 'targeted-failure',
    }),
    failureTagsByTitle: Object.freeze({
      'File:Starfish Roentgen X-Ray 01 Nevit.svg': ['transparent-edge'],
    }),
  },
  {
    category: 'object',
    commonsCategory: 'Chairs by Charles and Ray Eames',
    count: 11,
    cohortByTitle: Object.freeze({
      'File:At The Henry Ford- Dearborn, MI (30912900993).jpg': 'extreme',
      'File:Charles eames per herman miller furniture, sedia a dondolo, 1952.jpg': 'targeted-failure',
    }),
    subjectCountByTitle: Object.freeze({
      'File:At The Henry Ford- Dearborn, MI (30912900993).jpg': 3,
    }),
    failureTagsByTitle: Object.freeze({
      'File:At The Henry Ford- Dearborn, MI (30912900993).jpg': ['small-component'],
    }),
  },
])

const tags = Object.freeze({
  portrait: ['fine-hair', 'same-color-background', 'occlusion', 'profile-face'],
  pet: ['fur-edge', 'ear-tip', 'tail-missing', 'black-on-black'],
  illustration: ['thin-structure', 'internal-hole', 'transparent-edge'],
  object: ['hard-corner', 'small-component', 'internal-hole'],
})

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function metadata(info, name) {
  return stripHtml(info.extmetadata?.[name]?.value)
}

function artifactUrl(value) {
  const url = new URL(value)
  url.search = ''
  return url.toString()
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function fetchWikimediaWithRetry(
  fetch,
  url,
  options,
  attempts = 6,
  sleep = wait,
  requestTimeoutMs = 15_000,
) {
  let response
  let connectionError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const signal = options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal])
      response = await fetch(url, { ...options, signal })
      connectionError = undefined
    } catch (error) {
      connectionError = error
      if (attempt === attempts - 1) throw error
      await sleep(Math.min(30_000, 1_500 * (2 ** attempt)))
      continue
    }
    if (response.status !== 429 && response.status < 500) return response
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : Math.min(30_000, 1_500 * (2 ** attempt))
    await sleep(delay)
  }
  if (connectionError !== undefined) throw connectionError
  return response
}

export function createWikimediaCandidate({
  page,
  imageId,
  category,
  cohort,
  failureTags,
  subjectCount = 1,
  targetMobile,
  sourceCategory,
}) {
  const info = page?.imageinfo?.[0]
  if (info === undefined) throw new TypeError('Wikimedia page lacks imageinfo')
  const license = metadata(info, 'LicenseShortName')
  if (allowedLicenses.test(license) === false) {
    throw new RangeError(`Wikimedia license is outside the accepted set: ${license}`)
  }
  return {
    imageId,
    imagePath: `candidates/${imageId}.png`,
    category,
    cohort,
    failureTags,
    subjectCount,
    targetMobile,
    expectedDifficulty: cohort === 'extreme' ? 'extreme' : 'standard',
    source: {
      permission: /public domain|cc0/i.test(license) ? 'public-domain' : 'licensed',
      reference: page.title,
      url: info.descriptionurl,
      notes: [license, metadata(info, 'Artist'), `Commons category: ${sourceCategory}`]
        .filter((value) => value.length > 0)
        .join(' | '),
    },
    downloadUrl: artifactUrl(info.thumburl ?? info.url),
  }
}

async function queryCommonsCategory(category, fetch) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'categorymembers',
    gcmtitle: `Category:${category.replaceAll(' ', '_')}`,
    gcmtype: 'file',
    gcmlimit: '100',
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: '1024',
    origin: '*',
  })
  const response = await fetchWikimediaWithRetry(fetch, `https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'ai-bead-pattern-mask-gate/0.3.5' },
  })
  if (response.ok === false) throw new Error(`Commons request failed: ${response.status}`)
  const result = await response.json()
  return Object.values(result.query?.pages ?? {})
    .filter((page) => {
      const info = page.imageinfo?.[0]
      const license = metadata(info ?? {}, 'LicenseShortName')
      return info !== undefined && allowedLicenses.test(license)
        && /^image\/(jpeg|png|webp|gif|svg\+xml)$/i.test(info.mime ?? '')
    })
    .toSorted((first, second) => first.title.localeCompare(second.title))
}

function cohortFor(index, count) {
  if (index === count - 2) return 'clean-control'
  if (index === count - 1) return 'extreme'
  return 'targeted-failure'
}

export function selectWikimediaPages(pages, usedTitles, count, excludeTitles = []) {
  const excluded = new Set(excludeTitles)
  return pages
    .filter((page) => usedTitles.has(page.title) === false && excluded.has(page.title) === false)
    .slice(0, count)
}

export async function canReuseWikimediaArtifact(imagePath, metadataPath, candidate) {
  try {
    await access(imagePath)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    return metadata.reference === candidate.source.reference
      && metadata.downloadUrl === candidate.downloadUrl
  } catch {
    return false
  }
}

export function assignWikimediaMobileTargets(candidates, perCategory = 2) {
  if (Number.isInteger(perCategory) === false || perCategory < 0) {
    throw new RangeError('Mobile targets per category must be a non-negative integer')
  }
  const assigned = new Map()
  return candidates.map((candidate) => {
    const current = assigned.get(candidate.category) ?? 0
    const targetMobile = candidate.cohort === 'targeted-failure' && current < perCategory
    if (targetMobile) assigned.set(candidate.category, current + 1)
    return { ...candidate, targetMobile }
  })
}

export async function buildWikimediaCandidatePool({
  outputDirectory,
  poolPath,
  protocolVersion = 'mask-gate-v2',
  datasetId = 'mask-gate-2026-08',
  candidatePoolId = 'wikimedia-candidate-pool-2026-08',
  freezeSeed = 'wikimedia-freeze-v1',
  sampleOrderSeed = 'wikimedia-order-v1',
  modelConfigurationId = 'birefnet-general-lite-post-v1',
  commits,
  fetch = globalThis.fetch,
  onProgress = () => {},
}) {
  await mkdir(outputDirectory, { recursive: true })
  const candidates = []
  const usedTitles = new Set()
  const categoryIndexes = new Map()
  const categoryTotals = Object.fromEntries(
    ['portrait', 'pet', 'illustration', 'object'].map((category) => [
      category,
      wikimediaSourcePlan.filter((entry) => entry.category === category)
        .reduce((sum, entry) => sum + entry.count, 0),
    ]),
  )

  for (const source of wikimediaSourcePlan) {
    onProgress(`Querying ${source.commonsCategory}`)
    const pages = await queryCommonsCategory(source.commonsCategory, fetch)
    const selected = selectWikimediaPages(
      pages,
      usedTitles,
      source.count,
      source.excludeTitles,
    )
    if (selected.length < source.count) {
      throw new RangeError(
        `Commons category ${source.commonsCategory} returned ${selected.length}/${source.count} licensed images`,
      )
    }
    for (const page of selected) {
      usedTitles.add(page.title)
      const categoryIndex = categoryIndexes.get(source.category) ?? 0
      categoryIndexes.set(source.category, categoryIndex + 1)
      const imageId = `${source.category}-${String(categoryIndex + 1).padStart(2, '0')}`
      const cohort = source.cohortByTitle?.[page.title]
        ?? cohortFor(categoryIndex, categoryTotals[source.category])
      const candidate = createWikimediaCandidate({
        page,
        imageId,
        category: source.category,
        cohort,
        failureTags: source.failureTagsByTitle?.[page.title] ?? [cohort === 'clean-control'
          ? 'clean-mask'
          : tags[source.category][categoryIndex % tags[source.category].length]],
        subjectCount: source.subjectCountByTitle?.[page.title] ?? 1,
        targetMobile: false,
        sourceCategory: source.commonsCategory,
      })
      const imagePath = join(outputDirectory, `${imageId}.png`)
      const metadataPath = join(outputDirectory, `${imageId}.source.json`)
      const reusable = await canReuseWikimediaArtifact(imagePath, metadataPath, candidate)
      if (reusable === false) {
        onProgress(`Downloading ${imageId}: ${page.title}`)
        const response = await fetchWikimediaWithRetry(fetch, candidate.downloadUrl, {
          headers: { 'User-Agent': 'ai-bead-pattern-mask-gate/0.3.5' },
        })
        if (response.ok === false) throw new Error(`Image download failed: ${response.status}`)
        const image = await sharp(Buffer.from(await response.arrayBuffer()))
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer()
        await writeFile(imagePath, image)
        await writeFile(metadataPath, `${JSON.stringify({
          reference: candidate.source.reference,
          downloadUrl: candidate.downloadUrl,
        }, null, 2)}\n`)
        await wait(750)
      }
      const { downloadUrl, ...ledgerCandidate } = candidate
      candidates.push(ledgerCandidate)
    }
  }

  const pool = {
    schemaVersion: 1,
    candidatePoolId,
    protocolVersion,
    datasetId,
    freezeSeed,
    sampleOrderSeed,
    modelConfigurationId,
    commits,
    candidates: assignWikimediaMobileTargets(candidates),
  }
  await writeFile(poolPath, `${JSON.stringify(pool, null, 2)}\n`)
  onProgress(`Wrote ${poolPath}`)
  return pool
}
