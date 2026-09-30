"""Conservative review suggestions, never an automatic independence claim."""
from __future__ import annotations

from collections import defaultdict
import hashlib
import re
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from io_utils import digest, read_jsonl, verify_run, within, write_json, write_jsonl


def fingerprint(image: Image.Image) -> tuple[int, int]:
    # Fixed sheet region is used ONLY for similarity screening. This is neither
    # a decoded grid nor semantic segmentation; original references stay intact.
    if image.size == (1124, 720):
        image = image.crop((503, 75, 1105, 675))
    gray = np.asarray(image.convert('L').resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float32)
    def hash_one(array):
        low = cv2.dct(array)[:8, :8].flatten()[1:]
        return sum(int(bit) << i for i, bit in enumerate(low > np.median(low)))
    return hash_one(gray), hash_one(np.ascontiguousarray(gray[:, ::-1]))


def title_key(title: str) -> str:
    text = unicodedata.normalize('NFKC', title).casefold()
    text = re.sub(r'\b(?:mini|chibi|head|face|eyes?|pixel|art|perler|beads?|pattern|ver|version)\b', ' ', text)
    text = re.sub(r'[^\w\s]|\d+', ' ', text)
    text = ' '.join(text.split())
    return text if len(text) >= 4 else ''


def propose_groups(rows: list[dict], fingerprints: dict[str, tuple[int, int]], maximum_distance=5) -> list[dict]:
    links = []
    keys = {r['sampleId']: title_key(r.get('title') or '') for r in rows}
    for index, left in enumerate(rows):
        for right in rows[index + 1:]:
            reasons = []
            if left['contentSha256'] == right['contentSha256']:
                reasons.append('exact-content')
            if left.get('sourceGroupHint') and left['sourceGroupHint'] == right.get('sourceGroupHint'):
                reasons.append('source-group-hint')
            key = keys[left['sampleId']]
            if key and key == keys[right['sampleId']]:
                reasons.append('title-identity-hint')
            distance = None
            if left['sampleId'] in fingerprints and right['sampleId'] in fingerprints:
                a, b = fingerprints[left['sampleId']], fingerprints[right['sampleId']]
                distance = min((a[0] ^ b[0]).bit_count(), (a[0] ^ b[1]).bit_count(), (a[1] ^ b[0]).bit_count())
                if distance <= maximum_distance:
                    reasons.append('perceptual-or-mirrored-similarity')
            if reasons:
                links.append({'left': left['sampleId'], 'right': right['sampleId'], 'reasons': reasons,
                              'hashDistance': distance, 'status': 'pending-human-review'})
    return links


def group_inventory(run: Path) -> dict:
    config = verify_run(run)
    rows = sorted(read_jsonl(run / 'meta/inventory.jsonl'), key=lambda r: r['sampleId'])
    output = run / 'pilot/groups'
    output.mkdir(exist_ok=False)
    fingerprints, failures = {}, []
    for row in rows:
        try:
            path = within(Path(config['dataRoot']), row['originalPath'])
            if digest(path) != row['contentSha256']:
                raise ValueError('source-sha256-mismatch')
            with Image.open(path) as image:
                fingerprints[row['sampleId']] = fingerprint(image)
        except (OSError, ValueError) as error:
            failures.append({'sampleId': row['sampleId'], 'reason': str(error)})
    links = propose_groups(rows, fingerprints)
    adjacency = defaultdict(list)
    for link in links:
        adjacency[link['left']].append(link['right'])
        adjacency[link['right']].append(link['left'])
    # Components only describe the review queue, not accepted equivalence.
    components, seen = [], set()
    for row in rows:
        identity = row['sampleId']
        if identity in seen:
            continue
        stack, members = [identity], []
        while stack:
            item = stack.pop()
            if item in seen:
                continue
            seen.add(item)
            members.append(item)
            stack.extend(adjacency[item])
        members.sort()
        components.append({'proposalId': 'suggested-' + hashlib.sha256('\n'.join(members).encode()).hexdigest()[:16],
                           'members': members, 'reviewStatus': 'pending', 'split': 'unassigned'})
    write_jsonl(output / 'links.jsonl', links)
    write_jsonl(output / 'components.jsonl', components)
    write_jsonl(output / 'fingerprints.jsonl', [{'sampleId': key, 'normal': hex(value[0]), 'mirrored': hex(value[1])}
                                              for key, value in sorted(fingerprints.items())])
    report = {'samples': len(rows), 'fingerprinted': len(fingerprints), 'failures': failures,
              'suggestedLinks': len(links), 'reviewComponents': len(components), 'reviewedGroups': 0,
              'maximumHashDistance': 5, 'independentSplitReady': False,
              'inputSha256': digest(run / 'meta/inventory.jsonl'),
              'note': 'Similarity/title suggestions may overmerge or miss identities; all groups need review before splitting.'}
    write_json(output / 'report.json', report)
    return report
