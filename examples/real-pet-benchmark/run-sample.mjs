#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const root = resolve(new URL('../..', import.meta.url).pathname)
const work = join(root, 'work/real-pet-benchmark')
await mkdir(work, { recursive: true })
const image = join(root, 'apps/demo/assets/sample-cat.png')
const trimap = join(root, 'apps/demo/assets/sample-cat-mask.png')
const manifest = { datasetId: 'repository-sample-cat', samples: [{ sampleId: 'repository-sample-cat', imageId: 'sample-cat', category: 'pet', subjectKind: 'pet', breedGroup: 'repository-sample', sourceGroup: 'repository:sample-cat', split: 'development', sourceDataset: 'repository-owned-demo-asset', sourceUrl: 'https://github.com/Teddytututu/ai-bead-pattern/tree/main/apps/demo/assets', license: 'repository license', localPath: image, trimapPath: trimap, sha256: null, evaluationDimensions: ['subjectRecognition','silhouette','identityFeatures','palette','gridCleanliness','craftEase'] }] }
const manifestPath = join(work, 'sample-cat-manifest.json')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
const child = spawn(process.execPath, [join(root, 'tools/real-pet-benchmark/run.mjs'), '--manifest', manifestPath, '--output', join(root, 'examples/real-pet-benchmark/outputs'), '--sizes', '24,32,48,64,80', '--modes', 'baseline,ablation-no-shape,ablation-area-resize'], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
