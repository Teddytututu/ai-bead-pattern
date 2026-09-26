import unittest
from dataclasses import replace

import numpy as np
from PIL import Image

from sam2_sidecar.engine import BackendPrediction, Detection, GroundingPrediction, SegmentationBatchResult, SegmentationResult
from sam2_sidecar.parts import part_landmark, segment_parts, select_part_instances


def subject():
    mask = np.ones((60, 80), dtype=bool)
    return SegmentationResult(mask, mask.astype(np.float32), .95, .95, .9, 1, 1,
                              (10, 5, 60, 50), 'pet-01', 'cat', 'text+box', 0, 0, 1, 1, 'test')


class Detector:
    def __init__(self, detections):
        self.detections = detections

    def detect(self, image, labels):
        return GroundingPrediction(tuple(self.detections), 1, 'test')


class Backend:
    def __init__(self, masks):
        self.masks = masks

    def segment_boxes(self, image, boxes):
        return BackendPrediction(self.masks, np.ones(len(boxes)) * .9, 1, 'test')


class PartAdapterTests(unittest.TestCase):
    def test_preserves_network_masks_and_independent_eye_pose_with_nested_head(self):
        masks = np.zeros((3, 50, 60), dtype=np.float32)
        masks[0, 8:14, 10:20] = 1
        masks[1, 20:24, 36:42] = 1
        masks[2, 2:35, 2:50] = 1
        detections = [Detection((0, 0, 60, 50), .9, label) for label in ('eye', 'eye', 'head')]
        result = segment_parts(Image.new('RGB', (80, 60)), SegmentationBatchResult.from_instances((subject(),)), Detector(detections), Backend(masks))
        self.assertEqual(len(result.parts), 3)
        for index, part in enumerate(result.parts):
            np.testing.assert_array_equal(part.mask[5:55, 10:70], masks[index])
        first, second = [part_landmark(part, []) for part in result.parts[:2]]
        self.assertEqual((first['x'], first['y']), (24.5, 15.5))
        self.assertEqual((second['x'], second['y']), (48.5, 26.5))
        self.assertNotEqual(first['featureShape']['widthPx'], second['featureShape']['widthPx'])
        self.assertEqual(first['featureRegionId'], result.parts[0].instance_id)
        self.assertIsNone(part_landmark(result.parts[2], []))

    def test_missing_detection_does_not_synthesize_a_region(self):
        result = segment_parts(Image.new('RGB', (80, 60)), SegmentationBatchResult.from_instances((subject(),)), Detector([]), Backend(None))
        self.assertEqual(result.parts, ())
        self.assertTrue(result.warnings)

    def test_official_components_and_nms_remove_joint_duplicate_eye(self):
        left = np.zeros((60, 80), dtype=bool)
        right = left.copy()
        left[10:16, 10:18] = True
        right[18:22, 35:40] = True
        result = select_part_instances([
            replace(subject(), mask=left, label='eye', confidence=.9),
            replace(subject(), mask=right, label='eye', confidence=.8),
            replace(subject(), mask=left | right, label='eye', confidence=.6),
        ])
        self.assertEqual(len(result), 2)
        np.testing.assert_array_equal(result[0].mask, left)
        np.testing.assert_array_equal(result[1].mask, right)

    def test_single_visible_eye_is_not_mirrored(self):
        masks = np.zeros((1, 50, 60), dtype=np.float32)
        masks[0, 10:13, 10:16] = 1
        result = segment_parts(Image.new('RGB', (80, 60)), SegmentationBatchResult.from_instances((subject(),)), Detector([Detection((10, 10, 16, 13), .8, 'eye')]), Backend(masks))
        self.assertEqual(len(result.parts), 1)
        self.assertEqual(part_landmark(result.parts[0], [])['kind'], 'eye')

    def test_invalid_network_mask_dimensions_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'dimensions'):
            segment_parts(Image.new('RGB', (80, 60)), SegmentationBatchResult.from_instances((subject(),)), Detector([Detection((1, 1, 3, 3), .8, 'eye')]), Backend(np.zeros((1, 2, 2))))

    def test_opencv_preserves_tilted_mask_angle(self):
        mask = np.zeros((60, 80), dtype=bool)
        for offset in range(12):
            mask[10 + offset:13 + offset, 20 + offset] = True
        landmark = part_landmark(replace(subject(), mask=mask, label='eye'), [])
        self.assertAlmostEqual(landmark['featureShape']['angleDegrees'], 45, places=4)


if __name__ == '__main__':
    unittest.main()
