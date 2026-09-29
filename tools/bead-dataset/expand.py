"""Resumable, rate-limited expansion of public fuse-bead reference sheets."""
import collections
import concurrent.futures
import datetime
import gzip
import hashlib
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from PIL import Image
from paths import ROOT

LOCK = threading.Lock()
STOP = threading.Event()
NEXT_REQUEST = 0.0
LIMIT = 2400
UA = 'BeadReferenceCollector/1.1 (local reference dataset; rate-limited)'


def get(url):
    global NEXT_REQUEST
    if not url.startswith('https://kandipad.com/'):
        raise ValueError('Unexpected download host')
    with LOCK:
        delay = max(0, NEXT_REQUEST - time.monotonic())
        NEXT_REQUEST = max(time.monotonic(), NEXT_REQUEST) + 0.4
    if STOP.wait(delay):
        raise RuntimeError('Source stopped')
    for attempt in range(2):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(request, timeout=35) as response:
                if not response.url.startswith('https://kandipad.com/'):
                    raise ValueError('Unexpected redirect')
                data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError('Response too large')
            return data
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 429):
                STOP.set()
            raise
        except (TimeoutError, urllib.error.URLError):
            if attempt or STOP.wait(2):
                raise


def write_json(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


class Gallery(HTMLParser):
    def __init__(self):
        super().__init__()
        self.card = None
        self.cards = []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        classes = d.get('class', '').split()
        if tag == 'div' and 'gallery-project' in classes and d.get('id', '').startswith('project_'):
            self.card = {'slug': d['id'][8:], 'likes': int(d.get('data-likes', '0'))}
            self.depth = 1
        elif self.card is not None:
            if tag == 'div':
                self.depth += 1
            if tag == 'a' and 'project-title' in classes:
                self.card.update(title=d.get('title'), url=d.get('href'))
            if tag == 'img' and '/assets/images/projects/pp/' in d.get('src', ''):
                self.card.update(thumbnailUrl=d['src'], tagsText=d.get('alt', '').split(' - ', 1)[-1])
            if tag == 'div' and 'gallery-project-user' in classes:
                self.card['author'] = d.get('data-user')

    def handle_endtag(self, tag):
        if self.card is not None and tag == 'div':
            self.depth -= 1
            if self.depth == 0:
                if all(self.card.get(k) for k in ['title', 'url', 'thumbnailUrl', 'author']):
                    self.cards.append(self.card)
                self.card = None


def discover_page(task):
    query, page = task
    slug = re.sub(r'[^a-z0-9]+', '-', query.lower())
    relative = f'sources/catalog-{slug}-{page:03d}.html.gz'
    path = ROOT / relative
    url = 'https://kandipad.com/fuse-bead-patterns/popular' + (f'/{page}' if page > 1 else '') + '?' + urllib.parse.urlencode({'s': query})
    data = gzip.decompress(path.read_bytes()) if path.exists() else get(url)
    parser = Gallery()
    parser.feed(data.decode('utf-8'))
    if not parser.cards:
        raise ValueError(f'No public fuse-bead cards: {query}/{page}')
    if not path.exists():
        path.write_bytes(gzip.compress(data))
    return [{**r, 'discoveryQuery': query, 'sourceCatalogUrl': url, 'sourcePagePath': relative} for r in parser.cards]


ANIME = re.compile(r'\b(anime|manga|miku|vocaloid|teto|rin kagamine|len kagamine|kaito|naruto|sasuke|itachi|kakashi|sakura haruno|sailor|usagi|demon slayer|tanjiro|nezuko|rengoku|muichiro|shinobu|zenitsu|inosuke|jujutsu|gojo|geto|sukuna|nobara|yuji|megumi|one piece|luffy|zoro|sanji|chopper|ghibli|totoro|mononoke|spirited away|howl|chainsaw|denji|makima|spy x family|anya|frieren|pokemon|pikachu|eevee|gengar|digimon|dragon ball|goku|vegeta|hatsune|hunter x hunter|kurapika|killua|attack on titan|levi|eren|my hero|bakugo|deku|todoroki|uraraka|aizawa|haikyuu|hinata|kageyama|jojo|dio|jotaro|mononoke|hanako|black butler|ciel|evangelion|asuka|rei ayanami|genshin|honkai|ensemble stars|project sekai|kpop demon hunters)\b', re.I)
ANIMAL = re.compile(r'\b(animal|animals|cat|kitten|dog|puppy|tiger|lion|giraffe|bear|panda|rabbit|bunny|fox|wolf|raccoon|hamster|bird|owl|penguin|duck|horse|elephant|mammoth|deer|frog|turtle|shark|fish|axolotl|otter|capybara|chicken|sheep|cow|pig|bat|butterfly|moth|dolphin|whale|seal|hedgehog)\b', re.I)
FACE = re.compile(r'\b(face|faces|head|heads|headshot|portrait|portraits|bust|pfp|avatar|icon)\b', re.I)
EYES = re.compile(r'\b(eye|eyes|sharingan|rinnegan)\b', re.I)
OBJECT = re.compile(r'\b(logo|symbol|sword|wand|cloud|pokeball|fruit|light stick|guard|headband|bandana|seal|weapon|crest|flag|letter|leek)\b', re.I)


def classify(row):
    title = row['title']
    text = title + ', ' + row.get('tagsText', '')
    anime = bool(ANIME.search(text))
    animal = bool(ANIMAL.search(text))
    face = bool(FACE.search(text))
    eyes = bool(EYES.search(text))
    if not anime and not animal:
        return None
    if OBJECT.search(title) and not FACE.search(title) and not EYES.search(title):
        return None
    if re.search(r'\b(nsfw|gore|porn|hentai|wip|unfinished|test)\b', title, re.I):
        return None
    category = 'anime' if anime else 'animal'
    focus = 'eyes-candidate' if anime and eyes else 'face-candidate' if anime and face else 'character-candidate' if anime else 'animal-face-candidate' if face else 'animal-candidate'
    priority = 1 if anime and (face or eyes) else 2 if anime else 3
    return {**row, 'category': category, 'focus': focus, 'priority': priority}


def download(row):
    slug = row['slug']
    basename = urllib.parse.unquote(urllib.parse.urlparse(row['thumbnailUrl']).path.rsplit('/', 1)[1])
    # Verified against the original public detail pages in the first batch.
    url = 'https://kandipad.com/assets/images/projects/pp/full/' + urllib.parse.quote(basename)
    safe_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', slug)
    relative = f'originals/{safe_slug}.png'
    path = ROOT / relative
    data = path.read_bytes() if path.exists() else get(url)
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Not a PNG')
    with Image.open(io.BytesIO(data)) as image:
        dimensions = list(image.size)
        image.verify()
    if min(dimensions) < 600:
        raise ValueError('Not a full-size sheet')
    if not path.exists():
        path.write_bytes(data)
    return {
        **row, 'id': 'kandipad-' + slug, 'sourceSite': 'Kandi Pad',
        'sourceImageUrl': url, 'sourceImageUrlMethod': 'verified-gallery-full-sheet-path',
        'originalPath': relative, 'format': 'fuse-bead-pattern-sheet', 'imageSize': dimensions,
        'gridSize': None, 'beadCount': None,
        'contentSha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
        'downloadedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'authorizationStatus': 'pending', 'publicRedistribution': False, 'trainingEligible': False,
        'licenseUrl': 'https://kandipad.com/terms-of-use',
        'rightsNotes': 'Attribution retained; ML training and redistribution permission not established.',
        'visualReview': 'pending', 'classificationMethod': 'title-and-source-tags',
        'annotations': {'faceBox': None, 'landmarks': None, 'gridCells': None},
    }


def main():
    rows = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['samples']
    if len(rows) >= LIMIT:
        print(f'Already have {len(rows)} indexed sheets; target {LIMIT} reached.', flush=True)
        return
    existing = {r['url'] for r in rows}
    hashes = {r['contentSha256']: r['id'] for r in rows}
    plan = {'anime': 22, 'anime head': 40, 'anime eyes': 29, 'miku': 5, 'naruto': 4, 'demon slayer': 4, 'sailor moon': 3, 'one piece': 5, 'animal head': 20}
    tasks = [(q, p) for q, count in plan.items() for p in range(1, count + 1)]
    discovered = {}
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(discover_page, task): task for task in tasks}
        for i, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            try:
                for candidate in job.result():
                    classified = classify(candidate)
                    if classified and classified['url'] not in existing:
                        discovered.setdefault(classified['url'], classified)
            except Exception as error:
                errors.append({'phase': 'discovery', 'page': jobs[job], 'error': str(error)[:180]})
            if i % 10 == 0 or i == len(jobs):
                print(f'DISCOVER {i}/{len(jobs)} pages; {len(discovered)} new subject candidates', flush=True)
            if STOP.is_set():
                for pending in jobs:
                    pending.cancel()
                break
    candidates = sorted(discovered.values(), key=lambda r: (r['priority'], -r['likes'], r['url']))
    write_json(ROOT / 'expansion-seeds.json', candidates)
    print('CANDIDATE CATEGORIES', dict(collections.Counter(r['category'] for r in candidates)), flush=True)
    print('CANDIDATE FOCUS', dict(collections.Counter(r['focus'] for r in candidates)), flush=True)
    pending = candidates[:max(0, LIMIT - len(rows)) + 80]
    successes, duplicates = 0, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(download, seed): seed for seed in pending}
        for i, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            try:
                row = job.result()
                if row['contentSha256'] in hashes:
                    duplicates.append({'url': row['url'], 'duplicateOf': hashes[row['contentSha256']], 'localPath': row['originalPath']})
                else:
                    hashes[row['contentSha256']] = row['id']
                    rows.append(row)
                    successes += 1
            except Exception as error:
                errors.append({'phase': 'download', 'url': jobs[job]['url'], 'error': str(error)[:180]})
            if i % 25 == 0 or i == len(jobs) or STOP.is_set():
                write_json(ROOT / 'manifest.json', {'version': '2.0', 'samples': rows})
                write_json(ROOT / 'expansion-report.json', {'target': LIMIT, 'catalogPages': len(tasks), 'candidates': len(candidates), 'newDownloads': successes, 'total': len(rows), 'duplicates': duplicates, 'errors': errors, 'accessRestriction': STOP.is_set()})
                print(f'DOWNLOAD {i}/{len(jobs)}; dataset={len(rows)}; new={successes}; duplicates={len(duplicates)}; errors={len(errors)}', flush=True)
            if STOP.is_set():
                for queued in jobs:
                    queued.cancel()
                break
    print('COMPLETE', len(rows), 'total sheets', flush=True)


if __name__ == '__main__':
    main()
