"""Run the pinned neural detector/segmenter on sheet, panel and decoded views."""
from __future__ import annotations

from collections import Counter
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

from io_utils import PROJECT, digest, read_jsonl, verify_run, within, write_json, write_jsonl


def project_mask(mask: np.ndarray, transform: dict, width: int, height: int) -> tuple[list[float], list[bool]]:
    fractions = []
    for y in range(height):
        for x in range(width):
            x0 = transform['xOrigin'] + x * transform['pitchX']
            y0 = transform['yOrigin'] + y * transform['pitchY']
            x1, y1 = x0 + transform['pitchX'], y0 + transform['pitchY']
            left, top = max(0, math.floor(x0)), max(0, math.floor(y0))
            right, bottom = min(mask.shape[1], math.ceil(x1)), min(mask.shape[0], math.ceil(y1))
            patch = mask[top:bottom, left:right]
            fractions.append(float(patch.mean()) if patch.size and right > left and bottom > top else 0.)
    return fractions, [fraction >= .25 for fraction in fractions]


def mask_box(mask: list[bool], width: int) -> dict | None:
    indices = [i for i, occupied in enumerate(mask) if occupied]
    if not indices:
        return None
    xs, ys = [i % width for i in indices], [i // width for i in indices]
    return {'x': min(xs), 'y': min(ys), 'width': max(xs) - min(xs) + 1, 'height': max(ys) - min(ys) + 1}


def png_bytes(image: Image.Image) -> bytes:
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


def worker(job_path: Path) -> None:
    os.environ.setdefault('HF_HOME', str(PROJECT / '.tools/huggingface'))
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['SAM2_ALLOW_RUNTIME_DOWNLOAD'] = '0'
    from sam2_sidecar.contracts import GROUNDED_MODEL_DESCRIPTOR, InstancePrompt, SegmentationRequest
    from sam2_sidecar.engine import Sam2SegmentationEngine, encode_uncompressed_rle
    import torch
    job = json.loads(job_path.read_text(encoding='utf-8'))
    output = job_path.parent
    source = Path(job['source'])
    if digest(source) != job['sourceSha256']:
        raise ValueError('source changed since queue creation')
    with Image.open(source) as image:
        original = image.convert('RGB')
    calibration, grid = job['calibration'], job['grid']
    x, y, w, h = calibration['panel']
    # Integer crop boundaries and the translated full-grid transform are saved.
    crop_box = (math.floor(x), math.floor(y), math.ceil(x + w), math.ceil(y + h))
    panel = original.crop(crop_box)
    source_transform = grid['sourceToGrid']
    panel_transform = {**source_transform, 'xOrigin': x - crop_box[0], 'yOrigin': y - crop_box[1]}
    scale = 16
    flat = Image.fromarray(np.asarray(grid['rgb'], dtype=np.uint8).reshape(grid['height'], grid['width'], 3))
    flat = flat.resize((grid['width'] * scale, grid['height'] * scale), Image.Resampling.NEAREST)
    views = [('sheet', original, source_transform), ('panel', panel, panel_transform),
             ('flat', flat, {'xOrigin': 0., 'yOrigin': 0., 'pitchX': float(scale), 'pitchY': float(scale)})]
    engine = Sam2SegmentationEngine()
    records = []
    for name, image, transform in views:
        started = time.perf_counter()
        standalone = job['focus'] == 'eyes'
        labels = ('an eye',) if standalone else ('a person', 'a face', 'an anime character')
        if job['category'] == 'animal':
            labels = ('a cat', 'a dog', 'a rabbit', 'a bird', 'an animal')
        record = {'sampleId': job['sampleId'], 'view': name, 'status': 'running',
                  'sourceSha256': job['sourceSha256'], 'model': GROUNDED_MODEL_DESCRIPTOR,
                  'labels': list(labels), 'gridTransform': transform, 'parts': [],
                  'projectionThreshold': .25, 'humanReviewed': False}
        image.save(output / f'{name}.png')
        record['inputSha256'] = digest(output / f'{name}.png')
        try:
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            batch = engine.analyze(png_bytes(image), SegmentationRequest(
                capabilities=('subject-segmentation',) if standalone else ('subject-segmentation', 'semantic-parsing', 'keypoints'),
                image_type_hint='illustration', prompt=InstancePrompt(labels=labels),
                source_id=job['sampleId'], automatic_detection=True,
            ))
            overlay = image.convert('RGBA')
            raw_masks = []
            for part in (batch.instances if standalone else batch.parts):
                kind = 'eye' if standalone else part.label
                raw_masks.append({'instanceId': part.instance_id, 'label': part.label,
                    'width': image.width, 'height': image.height, 'rle': encode_uncompressed_rle(part.mask)})
                if kind not in ('eye', 'nose', 'mouth'):
                    continue
                fractions, mask = project_mask(part.mask, transform, grid['width'], grid['height'])
                box = mask_box(mask, grid['width'])
                record['parts'].append({'partId': f'{name}:{part.instance_id}', 'kind': kind,
                    'subjectInstanceId': None if standalone else part.instance_id.split(':', 1)[0],
                    'confidence': float(part.confidence), 'predictedIoU': float(part.predicted_iou),
                    'gridBox': box, 'gridMask': mask, 'gridFractions': fractions,
                    'projectionStatus': 'candidate' if box else 'no-grid-cells', 'visibility': 'unknown',
                    'side': 'unknown', 'origin': 'predicted'})
                color = {'eye': (255, 0, 128), 'nose': (0, 180, 255), 'mouth': (255, 170, 0)}[kind]
                layer = np.zeros((image.height, image.width, 4), dtype=np.uint8)
                layer[part.mask] = (*color, 110)
                overlay = Image.alpha_composite(overlay, Image.fromarray(layer))
            overlay.convert('RGB').save(output / f'{name}-overlay.png')
            write_json(output / f'{name}-raw-masks.json', raw_masks)
            record.update(status='predicted', instanceCount=len(batch.instances),
                warnings=list(batch.warnings), modelInferenceMs=batch.inference_ms, device=batch.device,
                peakGpuBytes=torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None)
        except Exception as error:
            record.update(status='failed', error=f'{type(error).__name__}: {error}')
        record['wallSeconds'] = time.perf_counter() - started
        records.append(record)
        write_json(output / f'{name}-prediction.json', record)
    write_json(output / 'result.json', records)


def preannotate(run: Path, limit: int) -> dict:
    config = verify_run(run)
    if not 1 <= limit <= config['budgets']['pilotCandidateLimit']:
        raise ValueError('limit outside frozen pilot budget')
    candidates = {r['sampleId']: r for r in read_jsonl(run / 'pilot/candidates.jsonl')}
    views_path = run / 'pilot/grid-read/views.jsonl'
    views = read_jsonl(views_path)
    selected = [r for r in views if r['status'] == 'pending-review'][:limit]
    output = run / 'pilot/neural'
    output.mkdir(exist_ok=False)
    records = []
    for i, view in enumerate(selected):
        row = candidates[view['sampleId']]
        files = view['files']
        for item in files.values():
            if digest(within(run, item['path'])) != item['sha256']:
                raise ValueError('grid artifact changed after decoding')
        grid = json.loads(within(run, files['grid.json']['path']).read_text(encoding='utf-8'))
        folder = output / Path(files['grid.json']['path']).parent.name
        folder.mkdir()
        job = {'sampleId': row['sampleId'], 'sourceSha256': row['contentSha256'],
               'source': str(within(Path(config['dataRoot']), row['originalPath'])),
               'category': row['category'], 'focus': row['focus'],
               'calibration': view['calibration'], 'grid': grid}
        write_json(folder / 'job.json', job)
        with (folder / 'stdout.log').open('x', encoding='utf-8') as out, (folder / 'stderr.log').open('x', encoding='utf-8') as err:
            try:
                completed = subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')), '_preannotate-worker',
                    '--job', str((folder / 'job.json').resolve())], stdout=out, stderr=err,
                    timeout=config['budgets']['timeoutSeconds'], check=False)
                result_path = folder / 'result.json'
                result = json.loads(result_path.read_text(encoding='utf-8')) if completed.returncode == 0 and result_path.exists() else []
                error = f'worker-exit-{completed.returncode}'
            except subprocess.TimeoutExpired:
                result, error = [], 'timeout'
        for name in ('sheet', 'panel', 'flat'):
            prediction = next((r for r in result if r['view'] == name), None)
            if prediction is None:
                # A timeout may leave completed views; retain those exact results.
                partial = folder / f'{name}-prediction.json'
                prediction = json.loads(partial.read_text(encoding='utf-8')) if partial.exists() else {
                    'sampleId': row['sampleId'], 'view': name, 'status': 'failed', 'error': error, 'parts': []}
            prediction['directory'] = folder.relative_to(run).as_posix()
            records.append(prediction)
        print(f'neural pilot {i + 1}/{len(selected)}: {row["sampleId"]}', flush=True)
        if sum(p.stat().st_size for p in run.rglob('*') if p.is_file()) >= config['budgets']['maximumRunBytes']:
            break
    attempted_ids = {r['sampleId'] for r in records}
    for row in candidates.values():
        if row['sampleId'] not in attempted_ids:
            records.append({'sampleId': row['sampleId'], 'view': None, 'status': 'not-attempted', 'parts': []})
    write_jsonl(output / 'predictions.jsonl', records)
    report = {'candidateDenominator': len(candidates), 'attemptedSamples': len(attempted_ids),
              'statuses': dict(Counter(r['status'] for r in records)),
              'views': {name: {'predicted': sum(r['view'] == name and r['status'] == 'predicted' for r in records),
                              'partCandidates': sum(len(r['parts']) for r in records if r['view'] == name)}
                        for name in ('sheet', 'panel', 'flat')},
              'gridViewsSha256': digest(views_path), 'reviewedParts': 0, 'precision': None, 'recall': None,
              'note': 'Predictions and failures only. More detections do not imply better quality.'}
    write_json(output / 'report.json', report)
    return report
