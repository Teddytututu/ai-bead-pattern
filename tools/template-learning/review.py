"""Build a local human-review page and import its explicit, auditable decisions.

Reviewing existing immutable predictions does not rerun generation, so source
artifacts are verified even when the review UI has a newer code version.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
from typing import Annotated, Literal

from PIL import Image
from pydantic import Field, field_validator

from contracts import Grid, Part, Point, Role, Target, Text, Visibility, Wire
from io_utils import digest, read_jsonl, verify_run, within, write_json, write_jsonl

TOOL = Path(__file__).resolve().parent


class Relation(Wire):
    otherId: Text
    decision: Literal['pending', 'same', 'different']


class Rights(Wire):
    decision: Literal['pending', 'granted', 'denied']
    basis: Literal['pending', 'owned', 'author-permission', 'license']
    evidence: Annotated[str, Field(max_length=4000)]


class PartReview(Wire):
    partId: Text
    sourceView: Literal['sheet', 'panel', 'flat', 'manual']
    kind: Part
    side: Literal['image-left', 'image-right', 'unknown', 'not-applicable']
    visibility: Visibility
    status: Literal['template', 'no_template', 'unknown']
    box: dict[str, int] | None
    anchor: Point | None
    cells: list[Role | Literal['unknown']]
    confirmed: bool
    elapsedSeconds: Annotated[float, Field(ge=0, le=86400)]


class SampleReview(Wire):
    sampleId: Text
    sourceSha256: Text
    gridSha256: Text
    occupancy: list[Literal[0, 1] | None]
    gridConfirmed: bool
    groupId: Annotated[str, Field(max_length=512)]
    groupConfirmed: bool
    relations: list[Relation]
    rights: Rights
    parts: list[PartReview]

    @field_validator('occupancy', mode='before')
    @classmethod
    def occupancy_types(cls, value):
        if not isinstance(value, list) or any(v is not None and type(v) is not int for v in value):
            raise ValueError('occupancy must use integer 0/1/null')
        return value


class ReviewBundle(Wire):
    schemaVersion: Literal['template-review-v1']
    packetSha256: Text
    runConfigSha256: Text
    reviewer: Annotated[str, Field(max_length=512)]
    exportedAt: Text
    samples: list[SampleReview]


def initial_part(part: dict, view: str, grid_width: int) -> dict:
    box = part['gridBox']
    cells = []
    if box:
        cells = ['unknown' if part['gridMask'][y * grid_width + x] else 'preserve-base'
                 for y in range(box['y'], box['y'] + box['height'])
                 for x in range(box['x'], box['x'] + box['width'])]
    return {'partId': part['partId'], 'sourceView': view, 'kind': part['kind'], 'side': 'unknown',
            'visibility': 'unknown', 'status': 'template' if box else 'unknown', 'box': box,
            'anchor': {'x': box['width'] // 2, 'y': box['height'] // 2} if box else None,
            'cells': cells, 'confirmed': False, 'elapsedSeconds': 0.}


def build(run: Path) -> dict:
    run = run.resolve()
    config = verify_run(run, check_code=False)
    inventory = {r['sampleId']: r for r in read_jsonl(run / 'meta/inventory.jsonl')}
    predictions_path = run / 'pilot/neural/predictions.jsonl'
    predictions = read_jsonl(predictions_path)
    views = read_jsonl(run / 'pilot/grid-read/views.jsonl')
    links_path = run / 'pilot/groups/links.jsonl'
    links = read_jsonl(links_path)
    chosen = {r['sampleId'] for r in predictions if r['view'] is not None}
    tasks, neighbors = [], {}
    for view in views:
        if view['sampleId'] not in chosen or view['status'] != 'pending-review':
            continue
        row = inventory[view['sampleId']]
        item = view['files']['grid.json']
        grid_path = within(run, item['path'])
        if digest(grid_path) != item['sha256']:
            raise ValueError('grid artifact changed before review')
        grid = json.loads(grid_path.read_text(encoding='utf-8'))
        source = within(Path(config['dataRoot']), row['originalPath'])
        if digest(source) != row['contentSha256']:
            raise ValueError('original changed before review')
        related = []
        for link in links:
            if row['sampleId'] not in (link['left'], link['right']):
                continue
            other = link['right'] if row['sampleId'] == link['left'] else link['left']
            related.append({'otherId': other, 'reasons': link['reasons'], 'hashDistance': link['hashDistance']})
            if other not in neighbors:
                reference = inventory[other]
                path = within(Path(config['dataRoot']), reference['originalPath'])
                if digest(path) != reference['contentSha256']:
                    raise ValueError('neighbor source hash mismatch')
                with Image.open(path) as image:
                    image = image.convert('RGB')
                    image.thumbnail((450, 290))
                    buffer = io.BytesIO()
                    image.save(buffer, format='PNG')
                neighbors[other] = {'sampleId': other, 'title': reference['title'], 'author': reference['author'],
                                    'thumbnail': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()}
        predictions_for_sample = [r for r in predictions if r['sampleId'] == row['sampleId'] and r['view']]
        parts, neural_views, evidence = [], [], {}
        for prediction in predictions_for_sample:
            folder = within(run, prediction['directory'])
            image_name = f'{prediction["view"]}-overlay.png' if prediction['status'] == 'predicted' else f'{prediction["view"]}.png'
            image_path = folder / image_name
            if not image_path.exists():
                image_path = within(run, view['files']['grid-overlay.png']['path'])
            neural_views.append({'name': prediction['view'], 'status': prediction['status'],
                'error': prediction.get('error'), 'warnings': prediction.get('warnings', []),
                'image': '../../' + image_path.relative_to(run).as_posix()})
            for part in prediction['parts']:
                parts.append(initial_part(part, prediction['view'], grid['width']))
                evidence[part['partId']] = {'confidence': part['confidence'], 'gridBox': part['gridBox'],
                    'gridMask': part['gridMask'], 'origin': 'predicted', 'sourceView': prediction['view']}
        tasks.append({'sampleId': row['sampleId'], 'title': row['title'], 'author': row['author'],
            'sourceUrl': row['sourceUrl'], 'sourceSha256': row['contentSha256'], 'gridSha256': item['sha256'],
            'sourceAuthorizationStatus': row['authorizationStatus'], 'sourceLicenseUrl': row.get('licenseUrl'),
            'sourceRightsNotes': row.get('rightsNotes'), 'grid': grid,
            'calibration': view['calibration'], 'views': neural_views, 'evidence': evidence,
            'related': related, 'initial': {'sampleId': row['sampleId'], 'sourceSha256': row['contentSha256'],
                'gridSha256': item['sha256'], 'occupancy': grid['occupancy'], 'gridConfirmed': False,
                'groupId': '', 'groupConfirmed': False, 'relations': [{'otherId': r['otherId'], 'decision': 'pending'} for r in related],
                'rights': {'decision': 'pending', 'basis': 'pending', 'evidence': ''}, 'parts': parts}})
    packet = {'schemaVersion': 'template-review-packet-v1', 'runConfigSha256': digest(run / 'meta/run-config.json'),
              'inputs': {p.relative_to(run).as_posix(): digest(p) for p in
                         (predictions_path, links_path, run / 'pilot/grid-read/views.jsonl')},
              'reviewToolSha256': {p.name: digest(p) for p in (Path(__file__), TOOL / 'review.html')},
              'tasks': tasks, 'neighbors': neighbors}
    output = run / 'pilot/review'
    output.mkdir(exist_ok=False)
    write_json(output / 'packet.json', packet)
    payload = json.dumps(packet, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c')
    page = (TOOL / 'review.html').read_text(encoding='utf-8').replace('__PACKET_SHA__', digest(output / 'packet.json')).replace('__DATA__', payload)
    (output / 'index.html').write_text(page, encoding='utf-8')
    report = {'tasks': len(tasks), 'draftParts': sum(len(t['initial']['parts']) for t in tasks),
              'neighborReferences': len(neighbors), 'humanReviewed': 0, 'trainingEligible': 0,
              'packetSha256': digest(output / 'packet.json')}
    write_json(output / 'report.json', report)
    candidates = read_jsonl(run / 'pilot/candidates.jsonl')
    write_jsonl(output / 'qualification-queue.jsonl', [{
        'sampleId': r['sampleId'], 'sourceSha256': r['contentSha256'], 'sourceUrl': r['sourceUrl'],
        'licenseUrl': r.get('licenseUrl'), 'authorizationStatus': r['authorizationStatus'],
        'reviewerDecision': 'pending', 'evidenceReference': None, 'trainingEligible': False,
        'missing': ['source-training-scope', 'reviewed-grid-and-parts', 'independent-design-split', 'FT1-quality-gates'],
    } for r in candidates])
    return report


def validate_reviews(bundle: ReviewBundle, packet: dict) -> tuple[list[dict], list[dict]]:
    tasks = {t['sampleId']: t for t in packet['tasks']}
    if bundle.runConfigSha256 != packet['runConfigSha256']:
        raise ValueError('review belongs to a different run')
    if len({s.sampleId for s in bundle.samples}) != len(bundle.samples):
        raise ValueError('duplicate sample reviews')
    reviewed, decisions = [], []
    groups = {s.sampleId: s.groupId for s in bundle.samples if s.groupConfirmed}
    for sample in bundle.samples:
        if sample.sampleId not in tasks:
            raise ValueError('unknown sample in review')
        task = tasks[sample.sampleId]
        if sample.sourceSha256 != task['sourceSha256'] or sample.gridSha256 != task['gridSha256']:
            raise ValueError('review source/grid version mismatch')
        grid = Grid.model_validate({k: task['grid'][k] for k in ('width', 'height', 'rgb', 'occupancy')})
        if len(sample.occupancy) != grid.width * grid.height:
            raise ValueError('review must preserve full occupancy grid')
        if sample.gridConfirmed and None in sample.occupancy:
            raise ValueError('complete grid review still contains unknown occupancy')
        accepted = [p for p in sample.parts if p.confirmed]
        any_confirmation = sample.gridConfirmed or sample.groupConfirmed or accepted or sample.rights.decision != 'pending'
        if any_confirmation and not bundle.reviewer.strip():
            raise ValueError('confirmed decisions require a named human reviewer')
        allowed_ids = {r['otherId'] for r in task['related']}
        if {r.otherId for r in sample.relations} != allowed_ids or len(sample.relations) != len(allowed_ids):
            raise ValueError('review must retain every suggested relationship')
        if sample.groupConfirmed and (not sample.groupId.strip() or any(r.decision == 'pending' for r in sample.relations)):
            raise ValueError('group confirmation needs group ID and all suggested relations reviewed')
        for relation in sample.relations:
            if sample.groupConfirmed and relation.otherId in groups:
                same = sample.groupId == groups[relation.otherId]
                if (relation.decision == 'same') != same:
                    raise ValueError('group IDs conflict with relationship decisions')
        if sample.rights.decision == 'granted' and (sample.rights.basis == 'pending' or not sample.rights.evidence.strip()):
            raise ValueError('training permission needs an explicit basis and evidence reference')
        if len({p.partId for p in sample.parts}) != len(sample.parts):
            raise ValueError('duplicate reviewed part IDs')
        for part in sample.parts:
            if part.sourceView != 'manual':
                if part.partId not in task['evidence'] or task['evidence'][part.partId]['sourceView'] != part.sourceView:
                    raise ValueError('reviewed part loses its prediction provenance')
            if not part.confirmed:
                continue
            if part.status == 'unknown':
                raise ValueError('unknown label must remain a draft')
            if part.status == 'template':
                if part.visibility not in ('visible', 'occluded'):
                    raise ValueError('template confirmation requires visible or partly occluded evidence')
                box = part.box
                if not box or set(box) != {'x', 'y', 'width', 'height'} or any(type(v) is not int for v in box.values()):
                    raise ValueError('reviewed template requires an integer grid box')
                if min(box['x'], box['y']) < 0 or min(box['width'], box['height']) < 1 or box['x'] + box['width'] > grid.width or box['y'] + box['height'] > grid.height:
                    raise ValueError('reviewed template outside full grid')
                if part.anchor is None:
                    raise ValueError('reviewed template requires a local anchor')
                anchor = part.anchor.model_dump()
                placement = {'x': box['x'] + anchor['x'], 'y': box['y'] + anchor['y']}
            else:
                box, anchor, placement = None, None, None
                if part.box is not None or part.anchor is not None or part.cells:
                    raise ValueError('no_template cannot retain a matrix')
            target = Target.model_validate({'inputId': sample.sampleId + ':' + part.partId, 'kind': part.kind,
                'visibility': part.visibility, 'status': part.status,
                'width': box['width'] if box else None, 'height': box['height'] if box else None,
                'cells': part.cells, 'anchor': anchor, 'placementAnchor': placement,
                'acceptableSizes': [[box['width'], box['height']]] if box else [],
                'review': {'reviewer': bundle.reviewer, 'reviewedAt': bundle.exportedAt,
                          'annotationVersion': 'template-review-v1', 'method': 'human', 'elapsedSeconds': part.elapsedSeconds}})
            reviewed.append({'sampleId': sample.sampleId, 'partId': part.partId, 'sourceView': part.sourceView,
                             'target': target.model_dump(), 'originalPrediction': task['evidence'].get(part.partId)})
        decisions.append({'sampleId': sample.sampleId, 'gridConfirmed': sample.gridConfirmed,
            'groupId': sample.groupId, 'groupConfirmed': sample.groupConfirmed,
            'relations': [r.model_dump() for r in sample.relations], 'rights': sample.rights.model_dump(),
            'reviewedParts': len(accepted), 'trainingEligible': False,
            'reasons': [label for label, passed in (
                ('grid-unreviewed', sample.gridConfirmed), ('group-unreviewed', sample.groupConfirmed),
                ('training-rights-pending-or-denied', sample.rights.decision == 'granted'), ('no-reviewed-parts', bool(accepted))) if not passed]
                + ['independent-split-not-frozen', 'FT1-quality-gates-not-passed']})
    return reviewed, decisions


def import_reviews(run: Path, review_file: Path, output: Path) -> dict:
    run = run.resolve()
    verify_run(run, check_code=False)
    packet_path = run / 'pilot/review/packet.json'
    packet = json.loads(packet_path.read_text(encoding='utf-8'))
    bundle = ReviewBundle.model_validate_json(review_file.read_text(encoding='utf-8'))
    if bundle.packetSha256 != digest(packet_path):
        raise ValueError('review packet hash mismatch')
    for relative, expected in packet['inputs'].items():
        if digest(within(run, relative)) != expected:
            raise ValueError('upstream review inputs changed')
    reviewed, decisions = validate_reviews(bundle, packet)
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / 'review-bundle.json', bundle.model_dump())
    write_jsonl(output / 'reviewed-targets.jsonl', reviewed)
    write_jsonl(output / 'sample-decisions.jsonl', decisions)
    write_jsonl(output / 'training-manifest.jsonl', [])
    report = {'receivedSamples': len(bundle.samples), 'reviewedParts': len(reviewed),
              'rights': dict(Counter(s.rights.decision for s in bundle.samples)),
              'trainingEligible': 0, 'independentSplitReady': False,
              'reviewSha256': digest(review_file), 'packetSha256': digest(packet_path),
              'missingSampleReviews': len(packet['tasks']) - len(bundle.samples),
              'note': 'Reviewed targets are preserved separately. Training still requires frozen independent splits and FT1 gates.'}
    write_json(output / 'report.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Local human review; no automatic truth or permission promotion')
    parser.add_argument('command', choices=('build', 'import'))
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--reviews', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'import' and (args.reviews is None or args.output is None):
        parser.error('import requires --reviews and a new --output directory')
    print(json.dumps(build(args.run) if args.command == 'build' else import_reviews(args.run, args.reviews, args.output),
                     ensure_ascii=False, indent=2))
