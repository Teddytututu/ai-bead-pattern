"""Download a bounded, curated list of public pattern sheets without modifying originals."""
import datetime
import hashlib
import html
import io
import json
import re
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

from PIL import Image
from paths import ROOT, metadata_path

MAX_BYTES = 16 * 1024 * 1024


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'img' and 'creation-thumb' in attrs.get('class', '').split():
            self.images.append(attrs)
        if tag == 'meta':
            self.meta[attrs.get('property', attrs.get('name', ''))] = attrs.get('content', '')


def fetch(url):
    if not url.startswith('https://kandipad.com/'):
        raise ValueError('Unexpected source host')
    time.sleep(0.65)
    request = urllib.request.Request(url, headers={
        'User-Agent': 'BeadReferenceCollector/1.0 (bounded local reference collection)',
    })
    with urllib.request.urlopen(request, timeout=35) as response:
        if not response.url.startswith('https://kandipad.com/'):
            raise ValueError('Unexpected redirect')
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('File exceeds 16 MiB limit')
    return data


def text_only(value):
    return ' '.join(html.unescape(re.sub('<[^>]+>', ' ', value)).split())


def capture(seed):
    slug = seed['url'].rsplit('/', 1)[1]
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', slug):
        raise ValueError('Unexpected filename')
    page_path = ROOT / 'sources' / (slug + '.html')
    if page_path.exists():
        data = page_path.read_bytes()
    else:
        data = fetch(seed['url'])
        page_path.write_bytes(data)
    content = data.decode('utf-8')
    page = Page()
    page.feed(content)
    kind = re.search(r'Pattern Type:\s*</strong>([^<]+)', content)
    if not kind or text_only(kind[1]) != 'Fuse Bead':
        raise ValueError('Not a fuse bead pattern')
    if len(page.images) != 1:
        raise ValueError('Missing or ambiguous original pattern sheet')
    image_url = page.images[0]['src']
    if '/assets/images/projects/pp/full/' not in image_url or not image_url.endswith('.png'):
        raise ValueError('Image is not a full original PNG pattern sheet')
    image_path = ROOT / 'originals' / (slug + '.png')
    image_bytes = image_path.read_bytes() if image_path.exists() else fetch(image_url)
    if not image_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Downloaded content is not PNG')
    with Image.open(io.BytesIO(image_bytes)) as img:
        image_size = list(img.size)
        img.verify()
    image_path.write_bytes(image_bytes)
    title = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', content)
    author = re.search(r'username:\s*"([^"\n]+)"', content)
    grid = re.search(r'Pattern Size:\s*</strong>\s*(\d+)x(\d+)', content)
    beads = re.search(r'Total Beads:\s*</strong>\s*([\d,]+)', content)
    return {
        **seed,
        'id': 'kandipad-' + slug,
        'title': text_only(title[1]) if title else seed['title'],
        'author': html.unescape(author[1]) if author else None,
        'sourceSite': 'Kandi Pad',
        'sourceImageUrl': image_url,
        'originalPath': image_path.relative_to(ROOT).as_posix(),
        'sourcePagePath': page_path.relative_to(ROOT).as_posix(),
        'format': 'fuse-bead-pattern-sheet',
        'imageSize': image_size,
        'gridSize': [int(grid[1]), int(grid[2])] if grid else None,
        'beadCount': int(beads[1].replace(',', '')) if beads else None,
        'contentSha256': hashlib.sha256(image_bytes).hexdigest(),
        'bytes': len(image_bytes),
        'downloadedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'authorizationStatus': 'pending',
        'publicRedistribution': False,
        'trainingEligible': False,
        'licenseUrl': 'https://kandipad.com/terms-of-use',
        'rightsNotes': 'Original with attribution retained; no explicit ML training or redistribution permission established.',
        'visualReview': 'pending',
        'annotations': {'faceBox': None, 'landmarks': None, 'gridCells': None},
    }


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for name in ['sources', 'originals', 'previews']:
        (ROOT / name).mkdir(exist_ok=True)
    seeds = json.loads(metadata_path('seeds.json').read_text(encoding='utf-8'))
    manifest_path = ROOT / 'manifest.json'
    if manifest_path.exists() and len(json.loads(manifest_path.read_text(encoding='utf-8'))['samples']) > len(seeds):
        raise SystemExit('Expanded dataset already exists; initial-batch collector will not overwrite it.')
    rows, failures, seen = [], [], {}
    for index, seed in enumerate(seeds, 1):
        try:
            row = capture(seed)
            if row['contentSha256'] in seen:
                failures.append({'url': seed['url'], 'status': 'exact-duplicate', 'duplicateOf': seen[row['contentSha256']]})
            else:
                seen[row['contentSha256']] = row['id']
                rows.append(row)
            print(f'{index}/{len(seeds)} OK {row["id"]} {row["gridSize"]}', flush=True)
        except Exception as error:
            failures.append({'url': seed['url'], 'status': 'failed', 'error': f'{type(error).__name__}: {str(error)[:180]}'})
            print(f'{index}/{len(seeds)} FAIL {type(error).__name__}: {str(error)[:120]}', flush=True)
            if isinstance(error, urllib.error.HTTPError) and error.code in [401, 403, 429]:
                print('Stopping at source access/rate restriction.', flush=True)
                break
        (ROOT / 'manifest.json').write_text(json.dumps({'version': '1.0', 'samples': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
        (ROOT / 'download-report.json').write_text(json.dumps({'requested': len(seeds), 'downloaded': len(rows), 'failures': failures}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'FINISHED: {len(rows)} unique sheets, {len(failures)} failures/duplicates', flush=True)


if __name__ == '__main__':
    main()
