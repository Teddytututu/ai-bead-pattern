"""Read only the effective manifest, never enumerate the originals directory."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from PIL import Image

from io_utils import digest, read_jsonl, within


def declared_scope(size) -> str:
    if not isinstance(size, list) or len(size) != 2 or any(type(v) is not int or v <= 0 for v in size):
        return 'unknown'
    return 'within-64' if max(size) <= 64 else 'outside-64'


def inventory(manifest: Path, data_root: Path) -> tuple[list[dict], dict]:
    originals = read_jsonl(manifest)
    if not originals or len({r['id'] for r in originals}) != len(originals):
        raise ValueError('effective manifest is empty or contains duplicate IDs')
    rows = []
    for row in originals:
        path = within(data_root, row['originalPath'])
        problems = []
        actual_sha, raster_size = None, None
        try:
            actual_sha = digest(path)
            if actual_sha != row['contentSha256']:
                problems.append('sha256-mismatch')
            with Image.open(path) as image:
                raster_size = list(image.size)
                image.verify()
            if raster_size != row.get('imageSize'):
                problems.append('raster-size-mismatch')
        except (OSError, ValueError) as error:
            problems.append(f'original-unavailable-or-invalid: {error}')
        group = row.get('relatedVariantGroup')
        rows.append({
            'sampleId': row['id'], 'title': row.get('title'), 'author': row.get('author'),
            'sourceUrl': row.get('url'), 'sourceImageUrl': row.get('sourceImageUrl'),
            'sourcePagePath': row.get('sourcePagePath'), 'licenseUrl': row.get('licenseUrl'),
            'rightsNotes': row.get('rightsNotes'),
            'originalPath': row['originalPath'], 'contentSha256': row['contentSha256'],
            'actualSha256': actual_sha, 'rasterSize': raster_size,
            'category': row.get('category'), 'focus': row.get('focus'),
            'visualReview': row.get('visualReview', 'pending'),
            'declaredGridSize': row.get('gridSize'),
            'declaredScope': declared_scope(row.get('gridSize')),
            'verifiedGridSize': None, 'verifiedScope': 'unknown', 'layout': 'unknown',
            'declaredBeadCount': row.get('beadCount'),
            'sourceGroupHint': group, 'exactContentGroup': row['contentSha256'],
            'designGroupReview': 'pending', 'split': 'unassigned',
            'authorizationStatus': row.get('authorizationStatus', 'pending'),
            'sourceTrainingEligible': row.get('trainingEligible') is True,
            'publicRedistribution': row.get('publicRedistribution') is True,
            'trainingEligible': False, 'labelReview': 'pending',
            'status': 'failed' if problems else 'pending-review',
            'reasons': problems or ['grid-layout-and-design-group-unreviewed', 'no-reviewed-part-targets'],
        })
    hashes = Counter(r['actualSha256'] for r in rows if r['actualSha256'])
    summary = {
        'total': len(rows), 'originalsVerified': sum(r['status'] != 'failed' for r in rows),
        'failed': sum(r['status'] == 'failed' for r in rows),
        'exactDuplicateExcess': sum(n - 1 for n in hashes.values()),
        'declaredScope': dict(Counter(r['declaredScope'] for r in rows)),
        'verifiedScope': {'unknown': len(rows)},
        'categories': dict(Counter(r['category'] for r in rows)),
        'focus': dict(Counter(r['focus'] for r in rows)),
        'authorizationStatus': dict(Counter(r['authorizationStatus'] for r in rows)),
        'sourceTrainingEligible': sum(r['sourceTrainingEligible'] for r in rows),
        'trainingEligible': 0, 'reviewedDesignGroups': 0,
    }
    return rows, summary


def select_candidates(rows: list[dict], seed: str) -> tuple[list[dict], dict]:
    import hashlib
    # Keep failures and out-of-scope records in the denominator. Selection does
    # not create train/test splits or claim independence from near duplicates.
    pools = {
        'face-eyes': [r for r in rows if r['category'] == 'anime' and r['focus'] in ('face', 'eyes')],
        'anime-character': [r for r in rows if r['category'] == 'anime' and r['focus'] not in ('face', 'eyes')],
        'animal': [r for r in rows if r['category'] == 'animal'],
    }
    selected, counts = [], {}
    for stratum, quota in (('face-eyes', 138), ('anime-character', 62), ('animal', 40)):
        pool = sorted(pools[stratum], key=lambda r: (hashlib.sha256((seed + r['sampleId']).encode()).hexdigest(), r['sampleId']))
        chosen = pool[:quota]
        counts[stratum] = {'requested': quota, 'available': len(pool), 'selected': len(chosen)}
        selected.extend({**r, 'stratum': stratum} for r in chosen)
    return selected, counts
