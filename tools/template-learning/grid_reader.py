"""Geometric calibration / sampling only; never infer semantic part masks.

The proposal is specific to Kandi Pad's 1124x720 sheet layout. It deliberately
leaves occupancy unknown until an explicit empty-cell reference is supplied.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import html
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from pydantic import Field, model_validator
from typing import Annotated, Literal, Self

from contracts import Byte, Text, Wire
from io_utils import digest, read_jsonl, verify_run, within, write_json, write_jsonl

READER_VERSION = 'square-annulus-v1'


class Calibration(Wire):
    sampleId: Text
    sourceSha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
    fullPattern: Literal[True]
    layout: Literal['square']
    width: Annotated[int, Field(ge=1, le=512)]
    height: Annotated[int, Field(ge=1, le=512)]
    # Pixel edges, before the first/after the last cell; no frame coordinates
    # are inferred from image pixels as a substitute for actual grid counts.
    panel: Annotated[list[float], Field(min_length=4, max_length=4)]
    emptyRgb: Annotated[list[Byte], Field(min_length=3, max_length=3)] | None
    calibrationStatus: Literal['candidate', 'reviewed']
    reviewer: Text | None

    @model_validator(mode='after')
    def coherent(self) -> Self:
        x, y, width, height = self.panel
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError('panel must have positive dimensions and nonnegative origin')
        if abs(width / self.width - height / self.height) / max(width / self.width, height / self.height) > 0.03:
            raise ValueError('square lattice pitch mismatch; reject hexagonal/distorted layouts')
        if self.calibrationStatus == 'reviewed' and not self.reviewer:
            raise ValueError('reviewed calibration requires a named reviewer')
        return self


def propose_panel(image: Image.Image, width: int, height: int) -> list[float]:
    if image.size != (1124, 720):
        raise ValueError('unsupported-sheet-layout; supply a manual square-grid calibration')
    gray = cv2.cvtColor(np.asarray(image.convert('RGB')), cv2.COLOR_RGB2GRAY)
    contours, _ = cv2.findContours(cv2.Canny(gray, 60, 180), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if x < image.width * 0.43 or w * h < 20000 or y < 15 or y + h > 680:
            continue
        if abs(w / width - h / height) / max(w / width, h / height) > 0.025:
            continue
        boxes.append((w * h, x, y, w, h))
    if not boxes:
        raise ValueError('no-square-panel-consistent-with-declared-grid')
    _, x, y, w, h = max(boxes)
    # Exclude one outer frame pixel; this remains a reviewable proposal.
    return [float(x + 1), float(y + 1), float(w - 2), float(h - 2)]


def sample_grid(image: Image.Image, calibration: Calibration) -> dict:
    x0, y0, panel_w, panel_h = calibration.panel
    if x0 + panel_w > image.width or y0 + panel_h > image.height:
        raise ValueError('panel outside source raster')
    pitch_x, pitch_y = panel_w / calibration.width, panel_h / calibration.height
    if min(pitch_x, pitch_y) < 5:
        raise ValueError('insufficient-pixels-per-cell')
    pixels = np.asarray(image.convert('RGB'))
    colors, occupancy, agreement = [], [], []
    # Ring sample avoids the center hole and cell border. The modal exact RGB
    # is useful for clean renderings; photographs require another reviewed route.
    for y in range(calibration.height):
        for x in range(calibration.width):
            cx, cy = x0 + (x + .5) * pitch_x, y0 + (y + .5) * pitch_y
            left, right = max(0, int(cx - .4 * pitch_x)), min(image.width, int(cx + .4 * pitch_x) + 1)
            top, bottom = max(0, int(cy - .4 * pitch_y)), min(image.height, int(cy + .4 * pitch_y) + 1)
            yy, xx = np.mgrid[top:bottom, left:right]
            distance = ((xx + .5 - cx) / pitch_x) ** 2 + ((yy + .5 - cy) / pitch_y) ** 2
            samples = pixels[top:bottom, left:right][(distance >= .26 ** 2) & (distance <= .39 ** 2)]
            if not len(samples):
                raise ValueError('empty-cell-sampling-region')
            color, count = Counter(map(tuple, samples.tolist())).most_common(1)[0]
            colors.append(list(color))
            agreement.append(count / len(samples))
            # Exact equality is intentional: close whites are not collapsed into
            # an empty cell. Mixed/antialiased samples remain unknown.
            occupancy.append(None if calibration.emptyRgb is None or count / len(samples) < .6
                             else int(list(color) != calibration.emptyRgb))
    return {'width': calibration.width, 'height': calibration.height, 'rgb': colors,
            'occupancy': occupancy, 'sampleAgreement': agreement,
            'sourceToGrid': {'xOrigin': x0, 'yOrigin': y0, 'pitchX': pitch_x, 'pitchY': pitch_y},
            'gridScope': 'within-64' if max(calibration.width, calibration.height) <= 64 else 'outside-64'}


def render_views(image: Image.Image, calibration: Calibration, grid: dict, directory: Path) -> None:
    overlay = image.convert('RGB').copy()
    draw = ImageDraw.Draw(overlay)
    x, y, w, h = calibration.panel
    for column in range(calibration.width + 1):
        xx = x + column * w / calibration.width
        draw.line((xx, y, xx, y + h), fill='#ff0066', width=1)
    for row in range(calibration.height + 1):
        yy = y + row * h / calibration.height
        draw.line((x, yy, x + w, yy), fill='#ff0066', width=1)
    overlay.save(directory / 'grid-overlay.png')
    flat = Image.fromarray(np.asarray(grid['rgb'], dtype=np.uint8).reshape(calibration.height, calibration.width, 3))
    scale = max(1, min(16, 640 // max(calibration.width, calibration.height)))
    flat.resize((calibration.width * scale, calibration.height * scale), Image.Resampling.NEAREST).save(directory / 'sampled-grid.png')


def pilot(run: Path, limit: int, calibrations_path: Path | None = None) -> dict:
    config_path = run / 'meta' / 'run-config.json'
    config = verify_run(run)
    if limit < 1 or limit > config['budgets']['pilotCandidateLimit']:
        raise ValueError('pilot limit outside run budget')
    candidates_path = run / 'pilot' / 'candidates.jsonl'
    rows = read_jsonl(candidates_path)
    manual = None
    if calibrations_path:
        values = [Calibration.model_validate(row) for row in read_jsonl(calibrations_path)]
        manual = {value.sampleId: value for value in values}
        if len(manual) != len(values) or set(manual) - {r['sampleId'] for r in rows}:
            raise ValueError('duplicate/unknown calibration sample IDs')
        if len(manual) > limit:
            raise ValueError('manual calibrations exceed explicit run limit')
    selected = [r for r in rows if (r['sampleId'] in manual if manual is not None else r['declaredScope'] == 'within-64' and r['status'] != 'failed')][:limit]
    selected_ids = {r['sampleId'] for r in selected}
    directory = run / 'pilot' / 'grid-read'
    directory.mkdir(exist_ok=False)
    records, calibrations = [], []
    for row in rows:
        record = {'sampleId': row['sampleId'], 'status': 'not-attempted', 'reason': 'not-selected-for-calibration-diagnostic',
                  'split': 'unassigned', 'verifiedScope': 'unknown', 'trainingEligible': False}
        if row['sampleId'] in selected_ids:
            try:
                if sum(p.stat().st_size for p in run.rglob('*') if p.is_file()) >= config['budgets']['maximumRunBytes']:
                    raise ValueError('run-disk-budget-exceeded; stop expansion')
                source = within(Path(config['dataRoot']), row['originalPath'])
                if digest(source) != row['contentSha256']:
                    raise ValueError('source-sha256-mismatch')
                with Image.open(source) as original:
                    image = original.convert('RGB')
                if manual is not None:
                    calibration = manual[row['sampleId']]
                else:
                    width, height = row['declaredGridSize']
                    calibration = Calibration(sampleId=row['sampleId'], sourceSha256=row['contentSha256'],
                        fullPattern=True, layout='square', width=width, height=height,
                        panel=propose_panel(image, width, height), emptyRgb=None,
                        calibrationStatus='candidate', reviewer=None)
                if calibration.sourceSha256 != row['contentSha256']:
                    raise ValueError('calibration-source-sha256-mismatch')
                grid = sample_grid(image, calibration)
                folder = directory / hashlib.sha256(row['sampleId'].encode()).hexdigest()[:16]
                folder.mkdir()
                write_json(folder / 'grid.json', grid)
                render_views(image, calibration, grid, folder)
                calibrations.append(calibration.model_dump())
                record.update(status='pending-review', reason='calibration-occupancy-and-colors-need-gold-review',
                    readerVersion=READER_VERSION, sourceSha256=row['contentSha256'],
                    calibration=calibration.model_dump(), candidateScope=grid['gridScope'],
                    unknownOccupancyCells=grid['occupancy'].count(None),
                    files={p.name: {'path': p.relative_to(run).as_posix(), 'sha256': digest(p)} for p in sorted(folder.iterdir())})
            except (ValueError, OSError) as error:
                record.update(status='failed', reason=str(error))
        records.append(record)
    write_jsonl(directory / 'views.jsonl', records)
    write_jsonl(directory / 'calibrations.jsonl', calibrations)
    report = {'readerVersion': READER_VERSION, 'candidateDenominator': len(rows), 'attempted': len(selected),
        'statuses': dict(Counter(r['status'] for r in records)),
        'inputSha256': digest(candidates_path), 'configSha256': digest(config_path),
        'calibrationsSha256': digest(calibrations_path) if calibrations_path else None,
        'occupancyAccuracy': None, 'colorIndexAccuracy': None, 'automaticAccepted': 0,
        'humanReviewedGold': 0, 'splitStatus': 'unassigned',
        'note': 'Calibration diagnostics only; not the held-out FT1 experiment. No semantic masks inferred.'}
    write_json(directory / 'report.json', report)
    cards = []
    for record in records:
        if record['status'] != 'pending-review':
            continue
        calibration = record['calibration']
        overlay = Path(record['files']['grid-overlay.png']['path']).relative_to('pilot/grid-read').as_posix()
        sampled = Path(record['files']['sampled-grid.png']['path']).relative_to('pilot/grid-read').as_posix()
        cards.append(f'<article><h2>{html.escape(record["sampleId"])}</h2>'
                     f'<p>{calibration["width"]} × {calibration["height"]} cells · '
                     f'unknown occupancy: {record["unknownOccupancyCells"]} · pending review</p>'
                     f'<div><img src="{overlay}" alt="Source with proposed grid">'
                     f'<img class="sampled" src="{sampled}" alt="Sampled colors; occupancy unreviewed"></div></article>')
    page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>FT1 grid calibration diagnostics</title>'
    page += '<style>body{font:16px system-ui;margin:32px;background:#edf1f5;color:#18263a}article{background:white;padding:20px;margin:24px 0;border-radius:12px}h2{font-size:18px;overflow-wrap:anywhere}article div{display:flex;align-items:center;gap:24px;flex-wrap:wrap}img{max-width:65%;height:auto}.sampled{max-width:30%;image-rendering:pixelated}p{color:#526176}</style>'
    page += '<h1>Grid calibration diagnostics</h1><p>Candidate geometry and sampled colors only. No human gold labels, accepted occupancy, dataset split, or accuracy claim. Original attribution is retained in each source overlay.</p>'
    page += ''.join(cards) + '</html>'
    (directory / 'index.html').write_text(page, encoding='utf-8')
    return report
