import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import { renderMaskGateContactSheet } from '../src/contact-sheet.mjs'

describe('Mask Gate contact sheet', () => {
  it('renders labeled candidates into a deterministic grid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-contact-sheet-'))
    try {
      const first = join(directory, 'first.png')
      const second = join(directory, 'second.png')
      const output = join(directory, 'contact-sheet.png')
      await Promise.all([
        sharp({ create: { width: 20, height: 10, channels: 3, background: '#ef4444' } })
          .png().toFile(first),
        sharp({ create: { width: 10, height: 20, channels: 3, background: '#3b82f6' } })
          .png().toFile(second),
      ])

      await renderMaskGateContactSheet({
        entries: [
          { imageId: 'portrait-01', category: 'portrait', cohort: 'targeted-failure', path: first },
          { imageId: 'pet-01', category: 'pet', cohort: 'clean-control', path: second },
        ],
        outputPath: output,
        columns: 2,
        thumbnailSize: 96,
      })

      const metadata = await sharp(output).metadata()
      assert.equal(metadata.width, 224)
      assert.equal(metadata.height, 148)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
