from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from PIL import Image, ImageDraw
from pydantic import ValidationError

from contracts import GenerationInput, GenerationOutput, Target, tensorize, validate_output, validate_target
from grid_reader import Calibration, sample_grid, pilot
from inventory import inventory, select_candidates
from io_utils import digest, verify_run, write_jsonl
from prepare import prepare
from runtime import probe


def request_dict(width=12, height=3):
    n = width * height
    return {
        'inputId': 'input-one', 'task': 'A-reconstruction', 'inputStage': 'decoded-pattern',
        'patternGrid': {'width': width, 'height': height, 'rgb': [[i % 256, 30, 50] for i in range(n)], 'occupancy': [1] * n},
        'validGridMask': [True] * n, 'segmentationEvidence': [],
        'partQuery': {'kind': 'eye', 'subjectInstanceId': None, 'faceInstanceId': None,
                      'partInstanceId': None, 'position': {'x': 0, 'y': 0}, 'side': 'unknown'},
        'constraints': {'maximumOccupiedCells': n, 'maximumColors': 4,
                        'protectedGridMask': [False] * n, 'lockedGridMask': [False] * n,
                        'neighborGridMask': [False] * n, 'minimumNeighborGap': 0},
        'sourceVersions': {'preprocessing': 'v1', 'segmentation': 'pinned-v1', 'palette': 'generic-24'},
    }


def output_dict():
    return {'inputId': 'input-one', 'kind': 'eye', 'status': 'candidates', 'reason': None,
        'candidates': [{'candidateId': 'c1', 'width': 9, 'height': 1, 'cells': ['eye-dark'] * 9,
                       'anchor': {'x': 4, 'y': 0}, 'placementAnchor': {'x': 4, 'y': 0}, 'confidence': .8}],
        'sourceVersions': request_dict()['sourceVersions'], 'generatorVersion': 'test-fixture-only'}


class ContractTests(unittest.TestCase):
    def test_rectangle_padding_retains_whole_context_and_blank(self):
        value = request_dict()
        value['patternGrid']['occupancy'][0] = 0
        value['patternGrid']['occupancy'][1] = None
        request = GenerationInput.model_validate(value)
        tensors = tensorize(request)
        self.assertEqual(int(tensors['validGridMask'].sum()), 36)
        self.assertTrue(tensors['validGridMask'][0, 0])
        self.assertFalse(tensors['validGridMask'][3, 0])
        self.assertEqual(tensors['occupancy'][0, 0], 0)
        self.assertEqual(tensors['occupancy'][0, 1], -1)
        np.testing.assert_array_equal(tensors['rgb'][2, 11], [35, 30, 50])
        self.assertEqual(GenerationInput.model_validate_json(request.model_dump_json()), request)

    def test_rejects_cropped_or_padded_wire_and_invalid_numbers(self):
        cases = []
        for mutate in (
            lambda v: v['patternGrid'].update(width=65),
            lambda v: v['patternGrid']['rgb'].pop(),
            lambda v: v['patternGrid']['occupancy'].__setitem__(0, True),
            lambda v: v['patternGrid']['rgb'].__setitem__(0, [0, 0, 256]),
            lambda v: v['validGridMask'].__setitem__(0, False),
            lambda v: v['validGridMask'].append(False),
            lambda v: v['constraints']['lockedGridMask'].pop(),
            lambda v: v['partQuery']['position'].update(x=12),
            lambda v: v.update(task='B-conversion'),
        ):
            value = request_dict()
            mutate(value)
            cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                GenerationInput.model_validate(value)

    def test_label_leakage_rejected_at_nested_boundaries(self):
        for location in ([], ['patternGrid'], ['partQuery'], ['constraints'], ['sourceVersions']):
            value = request_dict()
            container = value
            for key in location:
                container = container[key]
            container['targetWidth'] = 3
            with self.subTest(location=location), self.assertRaises(ValidationError):
                GenerationInput.model_validate(value)

    def test_evidence_ownership_and_predictions_only(self):
        value = request_dict()
        evidence = lambda id, kind, parent: {'instanceId': id, 'kind': kind, 'parentId': parent,
            'box': {'x': 0, 'y': 0, 'width': 12, 'height': 3}, 'mask': [True] * 36,
            'confidence': .7, 'visibility': 'visible', 'origin': 'predicted'}
        value['segmentationEvidence'] = [evidence('s1', 'subject', None), evidence('s2', 'subject', None), evidence('eye', 'eye', 's1')]
        value['partQuery'].update(subjectInstanceId='s1', partInstanceId='eye')
        GenerationInput.model_validate(value)
        for mutation in (
            lambda v: v['partQuery'].update(subjectInstanceId='s2'),
            lambda v: v['segmentationEvidence'][2].update(parentId='missing'),
            lambda v: v['segmentationEvidence'][0].update(parentId='eye'),
            lambda v: v['segmentationEvidence'][2].update(origin='human-reviewed'),
            lambda v: v['segmentationEvidence'][2].update(confidence=float('nan')),
            lambda v: v['segmentationEvidence'][2]['box'].update(width=1),
        ):
            bad = deepcopy(value)
            mutation(bad)
            with self.assertRaises(ValidationError):
                GenerationInput.model_validate(bad)

    def test_learned_width_above_eight_and_role_color_distinction(self):
        value = request_dict()
        value['constraints']['maximumColors'] = 1
        request = GenerationInput.model_validate(value)
        predicted = output_dict()
        predicted['candidates'][0]['cells'][0] = 'eye-highlight'
        # Multiple roles may resolve to one SKU; material validation is later.
        validate_output(GenerationOutput.model_validate(predicted), request)

    def test_invalid_predicted_shape_roles_and_no_template(self):
        for mutation in (
            lambda v: v['candidates'][0].update(width=0),
            lambda v: v['candidates'][0].update(height=2),
            lambda v: v['candidates'][0]['anchor'].update(x=9),
            lambda v: v['candidates'][0]['cells'].__setitem__(0, 'nose-base'),
            lambda v: v['candidates'][0]['cells'].__setitem__(0, 'unknown'),
            lambda v: v['candidates'][0].update(cells=['preserve-base'] * 9),
            lambda v: v.update(status='no_template'),
        ):
            value = output_dict()
            mutation(value)
            with self.assertRaises(ValidationError):
                GenerationOutput.model_validate(value)
        value = output_dict()
        value.update(status='no_template', candidates=[], reason='occluded')
        validate_output(GenerationOutput.model_validate(value), GenerationInput.model_validate(request_dict()))

    def test_placement_budget_locks_neighbor_and_versions(self):
        for mutation in (
            lambda r, o: o['candidates'][0]['placementAnchor'].update(x=11),
            lambda r, o: r['constraints'].update(maximumOccupiedCells=8),
            lambda r, o: r['constraints']['lockedGridMask'].__setitem__(0, True),
            lambda r, o: r['constraints']['protectedGridMask'].__setitem__(8, True),
            lambda r, o: r['constraints']['neighborGridMask'].__setitem__(4, True),
            lambda r, o: o['sourceVersions'].update(segmentation='wrong-version'),
            lambda r, o: o.update(inputId='wrong-id'),
        ):
            request, output = request_dict(), output_dict()
            mutation(request, output)
            with self.assertRaises(ValueError):
                validate_output(GenerationOutput.model_validate(output), GenerationInput.model_validate(request))
        request, output = request_dict(), output_dict()
        request['constraints']['lockedGridMask'][0] = True
        output['candidates'][0]['cells'][0] = 'preserve-base'
        validate_output(GenerationOutput.model_validate(output), GenerationInput.model_validate(request))

    def test_reviewed_targets_are_separate_and_unknown_is_not_absence(self):
        target = {'inputId': 'input-one', 'kind': 'eye', 'visibility': 'visible', 'status': 'template',
                  'width': 2, 'height': 1, 'cells': ['eye-dark', 'unknown'],
                  'anchor': {'x': 0, 'y': 0}, 'placementAnchor': {'x': 0, 'y': 0},
                  'acceptableSizes': [[2, 1], [1, 1]],
                  'review': {'reviewer': 'synthetic-test', 'reviewedAt': '2026-09-29',
                             'annotationVersion': 'test-only', 'method': 'human', 'elapsedSeconds': 10.0}}
        validate_target(Target.model_validate(target), GenerationInput.model_validate(request_dict()))
        bad = deepcopy(target)
        bad['placementAnchor']['x'] = 11
        with self.assertRaises(ValueError):
            validate_target(Target.model_validate(bad), GenerationInput.model_validate(request_dict()))
        target.update(status='no_template', width=None, height=None, cells=[], anchor=None,
                      placementAnchor=None, acceptableSizes=[], visibility='not-detected')
        with self.assertRaises(ValidationError):
            Target.model_validate(target)


class DatasetTests(unittest.TestCase):
    def fixture(self, root):
        image = root / 'image.png'
        Image.new('RGB', (1124, 720), 'white').save(image)
        return {'id': 'one', 'contentSha256': digest(image), 'originalPath': 'image.png',
            'imageSize': [1124, 720], 'gridSize': [19, 17], 'category': 'anime', 'focus': 'face',
            'trainingEligible': False, 'authorizationStatus': 'pending'}

    def test_integrity_and_declared_grid_never_become_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            row = self.fixture(root)
            rows = [row, {**row, 'id': 'missing', 'originalPath': 'missing.png', 'gridSize': None},
                    {**row, 'id': 'bad-hash', 'contentSha256': '0' * 64, 'gridSize': [96, 64]}]
            write_jsonl(root / 'manifest.jsonl', rows)
            records, summary = inventory(root / 'manifest.jsonl', root)
            self.assertEqual(summary['failed'], 2)
            self.assertEqual(summary['declaredScope'], {'within-64': 1, 'unknown': 1, 'outside-64': 1})
            self.assertTrue(all(r['verifiedScope'] == 'unknown' and not r['trainingEligible'] for r in records))

    def test_sampling_is_deterministic_keeps_failures_and_does_not_split(self):
        rows = [{'sampleId': str(i), 'category': 'anime' if i < 260 else 'animal',
                 'focus': 'face' if i < 138 else 'character', 'status': 'failed', 'split': 'unassigned'} for i in range(320)]
        a, quotas = select_candidates(rows, 'fixed-seed')
        b, _ = select_candidates(list(reversed(rows)), 'fixed-seed')
        self.assertEqual(a, b)
        self.assertEqual(len(a), 240)
        self.assertEqual(len({r['sampleId'] for r in a}), 240)
        self.assertTrue(all(r['split'] == 'unassigned' and r['status'] == 'failed' for r in a))
        self.assertEqual(quotas['animal']['selected'], 40)

    def test_path_escape_duplicate_ids_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            row = self.fixture(root)
            write_jsonl(root / 'escape.jsonl', [{**row, 'originalPath': '../outside.png'}])
            with self.assertRaises(ValueError):
                inventory(root / 'escape.jsonl', root)
            write_jsonl(root / 'duplicate.jsonl', [row, row])
            with self.assertRaises(ValueError):
                inventory(root / 'duplicate.jsonl', root)
            write_jsonl(root / 'manifest.jsonl', [row])
            run = root / 'run'
            report = prepare(root / 'manifest.jsonl', root, run, 'fixed')
            self.assertEqual(report['candidateCount'], 1)
            self.assertEqual((run / 'pilot' / 'training-manifest.jsonl').read_text(), '')
            for relative, sha in json.loads((run / 'meta' / 'artifact-hashes.json').read_text()).items():
                self.assertEqual(digest(run / relative), sha)
            with self.assertRaises(FileExistsError):
                prepare(root / 'manifest.jsonl', root, run, 'fixed')
            # Blank sheet is a recorded diagnostic failure, never a grid success.
            result = pilot(run, 1)
            self.assertEqual(result['statuses'], {'failed': 1})
            self.assertIsNone(result['occupancyAccuracy'])
            with self.assertRaises(FileExistsError):
                pilot(run, 1)

    def test_run_integrity_rejects_modified_candidates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_jsonl(root / 'manifest.jsonl', [self.fixture(root)])
            run = root / 'run'
            prepare(root / 'manifest.jsonl', root, run, 'fixed')
            verify_run(run)
            with (run / 'pilot' / 'candidates.jsonl').open('a') as stream:
                stream.write('\n')
            with self.assertRaisesRegex(ValueError, 'frozen run artifact changed'):
                verify_run(run)

    def test_runtime_timeout_and_worker_failure_remain_failures(self):
        import subprocess
        for timeout in (True, False):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                write_jsonl(root / 'manifest.jsonl', [self.fixture(root)])
                run = root / 'run'
                prepare(root / 'manifest.jsonl', root, run, 'fixed')
                with patch('runtime.subprocess.run') as command:
                    if timeout:
                        command.side_effect = subprocess.TimeoutExpired('worker', 300)
                    else:
                        command.return_value = subprocess.CompletedProcess('worker', 1)
                    result = probe(run, root / 'image.png')
                self.assertEqual(result['status'], 'timeout' if timeout else 'process-failed')
                self.assertTrue((run / 'meta' / 'runtime.json').is_file())
                with self.assertRaises(FileExistsError):
                    probe(run, root / 'image.png')


class GridReaderTests(unittest.TestCase):
    def calibration(self):
        return Calibration(sampleId='test', sourceSha256='a' * 64, fullPattern=True, layout='square',
                           width=3, height=1, panel=[0., 0., 60., 20.], emptyRgb=[247, 247, 247],
                           calibrationStatus='candidate', reviewer=None)

    def test_ring_sampling_avoids_hole_and_distinguishes_white_bead(self):
        image = Image.new('RGB', (60, 20), (247, 247, 247))
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 0, 39, 19), fill=(255, 255, 255))
        draw.rectangle((40, 0, 59, 19), fill=(30, 40, 50))
        for x in (30, 50):
            draw.ellipse((x - 3, 7, x + 3, 13), fill=(247, 247, 247))
        grid = sample_grid(image, self.calibration())
        self.assertEqual(grid['occupancy'], [0, 1, 1])
        self.assertEqual(grid['rgb'], [[247, 247, 247], [255, 255, 255], [30, 40, 50]])
        calibration = self.calibration().model_copy(update={'emptyRgb': None})
        self.assertEqual(sample_grid(image, calibration)['occupancy'], [None] * 3)

    def test_rejects_unsupported_geometry_and_does_not_shrink_large_design(self):
        spec = self.calibration().model_dump()
        for values in ({'layout': 'hexagonal'}, {'panel': [0., 0., 60., 40.]}, {'fullPattern': False},
                       {'panel': [float('nan'), 0., 60., 20.]}, {'calibrationStatus': 'reviewed'}):
            with self.assertRaises(ValidationError):
                Calibration.model_validate({**spec, **values})
        with self.assertRaises(ValueError):
            sample_grid(Image.new('RGB', (30, 20)), self.calibration())
        big = Calibration.model_validate({**spec, 'width': 96, 'panel': [0., 0., 960., 10.]})
        grid = sample_grid(Image.new('RGB', (960, 10)), big)
        self.assertEqual(grid['width'], 96)
        self.assertEqual(grid['gridScope'], 'outside-64')


if __name__ == '__main__':
    unittest.main()
