const { chromium } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../output/datasets/bead-patterns-2026-09-29');
const samples = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).samples;
const counts = (predicate) => samples.filter(predicate).length;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    // Verification is entirely local, including image loads.
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
    async function matched(expected) {
      const actual = Number(await page.locator('#count').getAttribute('data-matched'));
      if (actual !== expected) throw new Error(`Expected ${expected} results; got ${actual}`);
      if (await page.locator('.card').count() !== Math.min(72, expected)) throw new Error('Pagination size mismatch');
    }
    await matched(samples.length);
    const first = await page.locator('.card').first().getAttribute('data-id');
    await page.locator('#next').click();
    if (await page.locator('.card').first().getAttribute('data-id') === first) throw new Error('Next page did not change');
    await page.selectOption('#category', 'animal');
    await matched(counts(r => r.category === 'animal'));
    await page.selectOption('#category', '');
    await page.selectOption('#focus', 'face-priority');
    await matched(counts(r => ['face', 'eyes', 'face-candidate', 'eyes-candidate'].includes(r.focus)));
    await page.selectOption('#review', 'reviewed');
    await matched(counts(r => ['face', 'eyes', 'face-candidate', 'eyes-candidate'].includes(r.focus) && r.visualReview !== 'pending'));
    await page.selectOption('#focus', '');
    await page.selectOption('#review', '');
    await page.fill('#query', 'miku');
    const mikuCount = Number(await page.locator('#count').getAttribute('data-matched'));
    if (mikuCount < 10) throw new Error('Search returned too few Miku results');
    await page.fill('#query', 'unlikely-no-match-9938299');
    await matched(0);
    await page.fill('#query', '');
    await page.selectOption('#focus', 'face-priority');
    await page.screenshot({ path: path.join(root, 'previews', 'gallery.png') });
    if (errors.length) throw new Error(errors.join('\n'));
    const result = { total: samples.length, pageSize: 72, nextPage: true, categoryFilter: true, focusFilter: true, reviewFilter: true, mikuSearchResults: mikuCount, emptySearch: true, browserErrors: errors };
    fs.writeFileSync(path.join(root, 'gallery-validation.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
