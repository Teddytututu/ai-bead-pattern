import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  assignWikimediaMobileTargets,
  canReuseWikimediaArtifact,
  createWikimediaCandidate,
  fetchWikimediaWithRetry,
  selectWikimediaPages,
  wikimediaSourcePlan,
} from '../src/wikimedia-pool.mjs'

describe('Wikimedia candidate metadata', () => {
  it('maps explicit Commons license and source fields into the candidate ledger', () => {
    const candidate = createWikimediaCandidate({
      page: {
        title: 'File:Portrait.jpg',
        imageinfo: [{
          thumburl: 'https://upload.wikimedia.org/portrait.jpg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
          extmetadata: {
            LicenseShortName: { value: 'CC BY-SA 4.0' },
            Artist: { value: '<b>Example Author</b>' },
          },
        }],
      },
      imageId: 'portrait-01',
      category: 'portrait',
      cohort: 'targeted-failure',
      failureTags: ['fine-hair'],
      targetMobile: true,
      sourceCategory: 'Portrait photographs',
    })
    assert.equal(candidate.source.permission, 'licensed')
    assert.equal(candidate.source.reference, 'File:Portrait.jpg')
    assert.match(candidate.source.notes, /CC BY-SA 4.0/)
    assert.equal(candidate.downloadUrl, 'https://upload.wikimedia.org/portrait.jpg')
  })

  it('retries transient connection failures before returning a response', async () => {
    let attempts = 0
    const response = await fetchWikimediaWithRetry(async () => {
      attempts += 1
      if (attempts < 3) throw new TypeError('fetch failed')
      return { ok: true, status: 200, headers: new Headers() }
    }, 'https://commons.wikimedia.org/test', {}, 3, async () => {})

    assert.equal(response.status, 200)
    assert.equal(attempts, 3)
  })

  it('aborts a stalled Wikimedia request at the configured timeout', async () => {
    await assert.rejects(
      fetchWikimediaWithRetry((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }), 'https://commons.wikimedia.org/stalled', {}, 1, async () => {}, 5),
      /timeout|aborted/i,
    )
  })

  it('uses a narrow illustration source and removes excluded multi-subject files', () => {
    const illustrationSources = wikimediaSourcePlan.filter((source) =>
      source.category === 'illustration')
    assert.deepEqual(illustrationSources.map((source) => [source.commonsCategory, source.count]), [
      ['SVG animals', 11],
    ])

    assert.deepEqual(illustrationSources[0].excludeTitles, [
      'File:Cambrian beasties to scale.svg',
    ])
    assert.equal(
      illustrationSources[0].subjectCountByTitle['File:Hasengruppe von TRAUTMANN Dresden Plauen.svg'],
      3,
    )

    const pages = [
      { title: 'File:Agnostus.svg' },
      { title: 'File:Cambrian beasties to scale.svg' },
      { title: 'File:Cloudina.svg' },
    ]
    const selected = selectWikimediaPages(pages, new Set(), 2, illustrationSources[0].excludeTitles)
    assert.deepEqual(selected.map((page) => page.title), [
      'File:Agnostus.svg',
      'File:Cloudina.svg',
    ])
  })

  it('uses photograph-only people and pet sources plus a focused object source', () => {
    const portraitSources = wikimediaSourcePlan.filter((source) => source.category === 'portrait')
    assert.deepEqual(
      portraitSources.map((source) => [source.commonsCategory, source.count]),
      [['Portrait photographs of women', 8], ['Portrait photographs of men', 7]],
    )
    assert.deepEqual(portraitSources[0].excludeTitles, [
      'File:"Anasín Moanína, 11.05.20, Radolfzell, Deutschland.jpg".jpg',
    ])
    assert.equal(
      portraitSources[0].cohortByTitle['File:01 portrait motion blur experimental digital photography by Rick Doble.jpg'],
      'extreme',
    )
    const petSources = wikimediaSourcePlan.filter((source) => source.category === 'pet')
    assert.deepEqual(
      petSources.map((source) => [source.commonsCategory, source.count]),
      [['Portrait photographs of cats', 7], ['Portrait photographs of dogs', 8]],
    )
    assert.deepEqual(petSources[0].excludeTitles, [
      'File:"SVP, Je voudrais ma paté au lit !" (24240965816).jpg',
      'File:1 chat noir 04.jpg',
    ])
    assert.equal(petSources[1].cohortByTitle['File:- panoramio (3215).jpg'], 'clean-control')
    assert.equal(petSources[1].cohortByTitle['File:1898-winning-dogs 01.jpg'], 'targeted-failure')
    assert.equal(petSources[1].subjectCountByTitle['File:1898-winning-dogs 01.jpg'], 8)
    assert.equal(petSources[1].subjectCountByTitle['File:1898-winning-dogs 02.jpg'], 12)
    assert.deepEqual(
      wikimediaSourcePlan.filter((source) => source.category === 'object')
        .map((source) => [source.commonsCategory, source.count]),
      [['Chairs by Charles and Ray Eames', 11]],
    )
    const objectSource = wikimediaSourcePlan.find((source) => source.category === 'object')
    assert.ok(objectSource)
    assert.equal(
      objectSource.cohortByTitle['File:At The Henry Ford- Dearborn, MI (30912900993).jpg'],
      'extreme',
    )
    assert.equal(objectSource.subjectCountByTitle['File:At The Henry Ford- Dearborn, MI (30912900993).jpg'], 3)
    const illustrationSource = wikimediaSourcePlan.find((source) => source.category === 'illustration')
    assert.ok(illustrationSource)
    assert.equal(illustrationSource.cohortByTitle['File:Starfish Roentgen X-Ray 01 Nevit.svg'], 'extreme')
    assert.equal(illustrationSource.subjectCountByTitle['File:Tadpole (PSF).svg'], 4)
  })

  it('records an explicit subject count for grouped illustrations', () => {
    const candidate = createWikimediaCandidate({
      page: {
        title: 'File:Grouped.svg',
        imageinfo: [{
          url: 'https://upload.wikimedia.org/grouped.svg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Grouped.svg',
          extmetadata: { LicenseShortName: { value: 'Public domain' } },
        }],
      },
      imageId: 'illustration-01',
      category: 'illustration',
      cohort: 'targeted-failure',
      failureTags: ['thin-structure'],
      subjectCount: 3,
      targetMobile: false,
      sourceCategory: 'SVG animals',
    })
    assert.equal(candidate.subjectCount, 3)
  })

  it('reuses a downloaded image only when its source identity matches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wikimedia-artifact-'))
    try {
      const imagePath = join(directory, 'portrait-01.png')
      const metadataPath = join(directory, 'portrait-01.source.json')
      const candidate = {
        source: { reference: 'File:Portrait.jpg' },
        downloadUrl: 'https://upload.wikimedia.org/portrait.jpg',
      }
      await writeFile(imagePath, 'image')
      await writeFile(metadataPath, JSON.stringify({
        reference: candidate.source.reference,
        downloadUrl: candidate.downloadUrl,
      }))
      assert.equal(await canReuseWikimediaArtifact(imagePath, metadataPath, candidate), true)
      await writeFile(metadataPath, JSON.stringify({
        reference: 'File:Different.jpg',
        downloadUrl: candidate.downloadUrl,
      }))
      assert.equal(await canReuseWikimediaArtifact(imagePath, metadataPath, candidate), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('assigns mobile coverage to targeted failures after cohort overrides', () => {
    const candidates = assignWikimediaMobileTargets([
      { imageId: 'object-01', category: 'object', cohort: 'extreme', targetMobile: false },
      { imageId: 'object-02', category: 'object', cohort: 'targeted-failure', targetMobile: false },
      { imageId: 'object-03', category: 'object', cohort: 'targeted-failure', targetMobile: false },
      { imageId: 'object-04', category: 'object', cohort: 'targeted-failure', targetMobile: false },
    ])
    assert.deepEqual(candidates.map((candidate) => candidate.targetMobile), [false, true, true, false])
  })
})
