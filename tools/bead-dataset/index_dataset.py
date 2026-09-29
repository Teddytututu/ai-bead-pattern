"""Build portable local indexes and contact sheets for the downloaded references."""
import collections
import hashlib
import json
import sqlite3

from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageStat
from paths import PROJECT, ROOT, TOOLS, metadata_path



def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    (ROOT / 'previews').mkdir(exist_ok=True)
    exclusions_path = metadata_path('exclusions.json')
    exclusions = json.loads(exclusions_path.read_text(encoding='utf-8')) if exclusions_path.exists() else {}
    rows = []
    rejected = []
    for row in manifest['samples']:
        with Image.open(ROOT / row['originalPath']) as img:
            if max(ImageStat.Stat(img.convert('RGB').resize((64, 64))).stddev) < 1:
                exclusions[row['id']] = 'Blank solid-color raster; no visible pattern'
        if row['id'] in exclusions:
            rejected.append({**row, 'exclusionReason': exclusions[row['id']]})
        else:
            rows.append(row)
    manifest['samples'] = rows
    (ROOT / 'exclusions.json').write_text(json.dumps(exclusions, ensure_ascii=False, indent=2), encoding='utf-8')
    previous = json.loads((ROOT / 'excluded-manifest.json').read_text(encoding='utf-8')) if (ROOT / 'excluded-manifest.json').exists() else {'samples': []}
    rejected_by_id = {row['id']: row for row in previous['samples'] + rejected}
    (ROOT / 'excluded-manifest.json').write_text(json.dumps({'samples': list(rejected_by_id.values())}, ensure_ascii=False, indent=2), encoding='utf-8')
    reviews_path = metadata_path('visual-review.json')
    reviews = json.loads(reviews_path.read_text(encoding='utf-8')) if reviews_path.exists() else {}
    for row in rows:
        if row['id'] in reviews:
            row.update(reviews[row['id']])
        data = (ROOT / row['originalPath']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == row['contentSha256'], row['id']
        with Image.open(ROOT / row['originalPath']) as img:
            img.verify()
    assert len({row['contentSha256'] for row in rows}) == len(rows)
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT / 'manifest.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf-8')
    (ROOT / 'anime-face-manifest.json').write_text(json.dumps({'version': '1.0', 'samples': [r for r in rows if r['focus'] in ['face', 'eyes']]}, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT / 'anime-face-candidates.json').write_text(json.dumps({'version': '2.0', 'samples': [r for r in rows if r['focus'] in ['face', 'eyes', 'face-candidate', 'eyes-candidate']]}, ensure_ascii=False, indent=2), encoding='utf-8')
    evaluation = {'version': '1.0', 'samples': [{
        'sampleId': row['id'],
        'imageType': 'illustration',
        'source': row['url'],
        'authorizationStatus': row['authorizationStatus'],
        'contentSha256': row['contentSha256'],
        'publicRedistribution': False,
        'localPath': (ROOT / row['originalPath']).relative_to(PROJECT).as_posix(),
        'evaluationDimensions': ['feature-visibility', 'silhouette', 'palette', 'grid-cleanliness', 'craft-complexity'],
        'notes': 'Reference pattern sheet only; not a paired input/target or approved training sample. ' + row['focus'],
    } for row in rows]}
    (ROOT / 'evaluation-manifest.json').write_text(json.dumps(evaluation, ensure_ascii=False, indent=2), encoding='utf-8')
    with sqlite3.connect(ROOT / 'dataset.sqlite3') as db:
        db.execute('CREATE TABLE IF NOT EXISTS patterns (id TEXT PRIMARY KEY, title TEXT, author TEXT, category TEXT, focus TEXT, priority INTEGER, grid_width INTEGER, grid_height INTEGER, bead_count INTEGER, original_path TEXT, source_url TEXT, sha256 TEXT UNIQUE, authorization_status TEXT, training_eligible INTEGER, metadata_json TEXT)')
        db.execute('DELETE FROM patterns')
        db.executemany('INSERT INTO patterns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [(
            r['id'], r['title'], r['author'], r['category'], r['focus'], r['priority'],
            *(r['gridSize'] or [None, None]), r['beadCount'], r['originalPath'], r['url'],
            r['contentSha256'], r['authorizationStatus'], int(r['trainingEligible']), json.dumps(r, ensure_ascii=False),
        ) for r in rows])
        db.execute('CREATE INDEX IF NOT EXISTS patterns_focus ON patterns(category, focus, priority)')
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    try:
        font = ImageFont.truetype('Arial.ttf', 18)
    except OSError:
        font = ImageFont.load_default(size=18)
    for page, start in enumerate(range(0, len(rows), 16), 1):
        sheet = Image.new('RGB', (1600, 1240), '#e9eef4')
        draw = ImageDraw.Draw(sheet)
        for offset, row in enumerate(rows[start:start + 16]):
            x, y = offset % 4 * 400, offset // 4 * 310
            with Image.open(ROOT / row['originalPath']) as img:
                thumb = ImageOps.contain(img.convert('RGB'), (390, 255))
                sheet.paste(thumb, (x + (400 - thumb.width) // 2, y))
            draw.text((x + 8, y + 259), f'{start + offset + 1:02d} {row["title"][:34]}', fill='#18263a', font=font)
            draw.text((x + 8, y + 282), f'{row["focus"]} / {row["gridSize"]}', fill='#425875', font=font)
        sheet.save(ROOT / 'previews' / f'contact-{page:02d}.jpg', quality=92)
    counts = dict(collections.Counter(row['focus'] for row in rows))
    summary = {
        'total': len(rows), 'categories': dict(collections.Counter(row['category'] for row in rows)),
        'focus': counts, 'originalBytes': sum(row['bytes'] for row in rows),
        'exactDuplicates': 0, 'allOriginalsDecode': True, 'allHashesMatch': True,
        'excludedAfterQualityReview': len(rejected_by_id),
        'reviewed': sum(row['visualReview'] != 'pending' for row in rows),
        'facePriorityIncludingCandidates': sum(row['focus'] in ['face', 'eyes', 'face-candidate', 'eyes-candidate'] for row in rows),
        'pendingVisualReview': sum(row['visualReview'] == 'pending' for row in rows),
        'trainingEligible': sum(row['trainingEligible'] for row in rows),
    }
    (ROOT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    payload = json.dumps(rows, ensure_ascii=False).replace('</', '<\\/')
    page = (TOOLS / 'gallery.html').read_text(encoding='utf-8').replace('PAYLOAD', payload)
    (ROOT / 'index.html').write_text(page, encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
