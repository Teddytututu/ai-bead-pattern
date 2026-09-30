from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from pydantic import ValidationError

from grouping import propose_groups, title_key
from preannotate import project_mask, mask_box
from review import ReviewBundle, initial_part, validate_reviews


def fixture():
    part = {'partId': 'sheet:eye-1', 'kind': 'eye', 'gridBox': {'x': 1, 'y': 1, 'width': 2, 'height': 1},
            'gridMask': [False] * 5 + [True, True] + [False] * 5}
    initial = {'sampleId': 'one', 'sourceSha256': 'source-sha', 'gridSha256': 'grid-sha',
               'occupancy': [None] * 12, 'gridConfirmed': False, 'groupId': '', 'groupConfirmed': False,
               'relations': [{'otherId': 'two', 'decision': 'pending'}],
               'rights': {'decision': 'pending', 'basis': 'pending', 'evidence': ''},
               'parts': [initial_part(part, 'sheet', 4)]}
    packet = {'runConfigSha256': 'run-sha', 'tasks': [{
        'sampleId': 'one', 'sourceSha256': 'source-sha', 'gridSha256': 'grid-sha',
        'grid': {'width': 4, 'height': 3, 'rgb': [[100, 100, 100]] * 12, 'occupancy': [None] * 12},
        'related': [{'otherId': 'two'}], 'evidence': {'sheet:eye-1': {'sourceView': 'sheet', 'confidence': .8}},
    }]}
    bundle = {'schemaVersion': 'template-review-v1', 'packetSha256': 'packet-sha',
              'runConfigSha256': 'run-sha', 'reviewer': '', 'exportedAt': '2026-09-29T12:00:00Z', 'samples': [initial]}
    return packet, bundle


class ProjectionTests(unittest.TestCase):
    def test_rectangular_coordinate_mapping_matches_three_view_transforms(self):
        mask = np.zeros((30, 60), dtype=bool)
        mask[10:20, 20:40] = True
        fractions, mapped = project_mask(mask, {'xOrigin': 10., 'yOrigin': 0., 'pitchX': 10., 'pitchY': 10.}, 4, 3)
        cropped_fractions, cropped = project_mask(mask[:, 10:50], {'xOrigin': 0., 'yOrigin': 0., 'pitchX': 10., 'pitchY': 10.}, 4, 3)
        np.testing.assert_array_equal(fractions, cropped_fractions)
        self.assertEqual(mapped, cropped)
        self.assertEqual(mask_box(mapped, 4), {'x': 1, 'y': 1, 'width': 2, 'height': 1})
        self.assertEqual(fractions[5:7], [1., 1.])

    def test_empty_or_outside_masks_do_not_get_invented_cells(self):
        fractions, mask = project_mask(np.zeros((4, 4), dtype=bool), {'xOrigin': 20., 'yOrigin': 20., 'pitchX': 2., 'pitchY': 2.}, 3, 2)
        self.assertEqual(fractions, [0.] * 6)
        self.assertIsNone(mask_box(mask, 3))


class GroupTests(unittest.TestCase):
    def test_similarity_includes_mirror_and_identity_but_never_confirms(self):
        rows = [{'sampleId': 'a', 'contentSha256': 'a', 'title': 'Miku head'},
                {'sampleId': 'b', 'contentSha256': 'b', 'title': 'Chibi Miku 2'},
                {'sampleId': 'c', 'contentSha256': 'c', 'title': 'Other'}]
        links = propose_groups(rows, {'a': (0, 255), 'b': (255, 0), 'c': (2**32-1, 2**32-1)})
        self.assertEqual(len(links), 1)
        self.assertIn('title-identity-hint', links[0]['reasons'])
        self.assertIn('perceptual-or-mirrored-similarity', links[0]['reasons'])
        self.assertEqual(links[0]['status'], 'pending-human-review')
        self.assertEqual(title_key('Chibi Head 2'), '')


class ReviewTests(unittest.TestCase):
    def test_unconfirmed_machine_drafts_are_not_gold(self):
        packet, bundle = fixture()
        targets, decisions = validate_reviews(ReviewBundle.model_validate(bundle), packet)
        self.assertEqual(targets, [])
        self.assertFalse(decisions[0]['trainingEligible'])
        self.assertIn('training-rights-pending-or-denied', decisions[0]['reasons'])
        self.assertEqual(bundle['samples'][0]['parts'][0]['cells'], ['unknown', 'unknown'])

    def test_confirmed_target_requires_person_roles_and_visibility(self):
        packet, bundle = fixture()
        bundle['samples'][0]['parts'][0]['confirmed'] = True
        for change in (None, 'person', 'visibility'):
            if change == 'person':
                bundle['reviewer'] = 'synthetic-test-reviewer'
            if change == 'visibility':
                bundle['samples'][0]['parts'][0]['visibility'] = 'visible'
            with self.assertRaises(ValueError):
                validate_reviews(ReviewBundle.model_validate(bundle), packet)
        bundle['samples'][0]['parts'][0]['cells'] = ['eye-dark', 'unknown']
        targets, decisions = validate_reviews(ReviewBundle.model_validate(bundle), packet)
        self.assertEqual(targets[0]['target']['width'], 2)
        self.assertEqual(targets[0]['target']['placementAnchor'], {'x': 2, 'y': 1})
        self.assertIsNotNone(targets[0]['originalPrediction'])
        self.assertFalse(decisions[0]['trainingEligible'])

    def test_absence_cannot_be_created_from_missed_detection(self):
        packet, bundle = fixture()
        bundle['reviewer'] = 'synthetic-test'
        part = bundle['samples'][0]['parts'][0]
        part.update(status='no_template', confirmed=True, visibility='not-detected', box=None, anchor=None, cells=[])
        with self.assertRaises(ValidationError):
            validate_reviews(ReviewBundle.model_validate(bundle), packet)
        part['visibility'] = 'not-drawn'
        targets, _ = validate_reviews(ReviewBundle.model_validate(bundle), packet)
        self.assertEqual(targets[0]['target']['status'], 'no_template')

    def test_grid_confirmation_requires_complete_occupancy(self):
        packet, bundle = fixture()
        bundle['reviewer'] = 'synthetic-test'
        bundle['samples'][0]['gridConfirmed'] = True
        with self.assertRaisesRegex(ValueError, 'unknown occupancy'):
            validate_reviews(ReviewBundle.model_validate(bundle), packet)
        bundle['samples'][0]['occupancy'] = [0] * 12
        validate_reviews(ReviewBundle.model_validate(bundle), packet)

    def test_source_grid_prediction_and_run_provenance_checked(self):
        for mutation in (
            lambda b: b.update(runConfigSha256='other-run'),
            lambda b: b['samples'][0].update(sourceSha256='changed'),
            lambda b: b['samples'][0].update(gridSha256='changed'),
            lambda b: b['samples'][0]['parts'][0].update(sourceView='flat'),
            lambda b: b['samples'].append(deepcopy(b['samples'][0])),
            lambda b: b['samples'][0].update(relations=[]),
        ):
            packet, bundle = fixture()
            mutation(bundle)
            with self.assertRaises(ValueError):
                validate_reviews(ReviewBundle.model_validate(bundle), packet)

    def test_training_rights_need_explicit_evidence(self):
        packet, bundle = fixture()
        bundle['reviewer'] = 'synthetic-test'
        rights = bundle['samples'][0]['rights']
        rights['decision'] = 'granted'
        with self.assertRaises(ValueError):
            validate_reviews(ReviewBundle.model_validate(bundle), packet)
        rights.update(basis='owned', evidence='test-fixture-not-real-authorization')
        _, decisions = validate_reviews(ReviewBundle.model_validate(bundle), packet)
        self.assertFalse(decisions[0]['trainingEligible'])
        self.assertIn('independent-split-not-frozen', decisions[0]['reasons'])

    def test_unreviewed_group_links_prevent_confirmation(self):
        packet, bundle = fixture()
        bundle['reviewer'] = 'synthetic-test'
        bundle['samples'][0].update(groupId='group-one', groupConfirmed=True)
        with self.assertRaises(ValueError):
            validate_reviews(ReviewBundle.model_validate(bundle), packet)
        bundle['samples'][0]['relations'][0]['decision'] = 'different'
        validate_reviews(ReviewBundle.model_validate(bundle), packet)


if __name__ == '__main__':
    unittest.main()
