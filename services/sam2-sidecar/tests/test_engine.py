import io
import unittest

import numpy as np
from PIL import Image

from sam2_sidecar.contracts import InstancePrompt, SegmentationRequest
from sam2_sidecar.engine import (
    BackendPrediction,
    Detection,
    GroundingPrediction,
    Sam2SegmentationEngine,
    SegmentationResult,
    TransformersGroundingDinoBackend,
    build_pixel_prompt,
    decode_uncompressed_rle,
    encode_uncompressed_rle,
    normalize_detection_labels,
    stable_detection_nms,
    stable_instance_geometry_order,
    stable_instance_mask_nms,
)


class FakeBackend:
    def __init__(self, prediction: BackendPrediction) -> None:
        self.prediction = prediction
        self.last_image = None
        self.last_prompt = None
        self.box_calls = []

    def health(self) -> tuple[str, str]:
        return "ready", "fake SAM2 ready"

    def segment(self, image: Image.Image, prompt):
        self.last_image = image
        self.last_prompt = prompt
        return self.prediction

    def segment_boxes(self, image: Image.Image, boxes):
        self.last_image = image
        self.box_calls.append(tuple(boxes))
        return self.prediction


class FakeDetector:
    def __init__(self, prediction: GroundingPrediction) -> None:
        self.prediction = prediction
        self.calls = []

    def health(self) -> tuple[str, str]:
        return "ready", "fake GroundingDINO ready"

    def detect(self, image: Image.Image, labels):
        self.calls.append((image.size, tuple(labels)))
        return self.prediction


def source_png(width: int = 80, height: int = 60) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (210, 170, 130, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


def request(prompt: InstancePrompt) -> SegmentationRequest:
    return SegmentationRequest(
        capabilities=("subject-segmentation",),
        image_type_hint="pet",
        prompt=prompt,
        source_id="cat-a",
    )


class PromptPlanningTests(unittest.TestCase):
    def test_lasso_builds_box_interior_positives_and_exterior_negatives(self) -> None:
        lasso = (
            (0.10, 0.15),
            (0.82, 0.18),
            (0.76, 0.86),
            (0.16, 0.82),
        )

        planned = build_pixel_prompt(
            InstancePrompt(lasso=lasso),
            width=200,
            height=100,
        )

        self.assertEqual(planned.source, "lasso")
        self.assertEqual(planned.box, (20.0, 15.0, 164.0, 86.0))
        self.assertGreaterEqual(len(planned.positive_points), 3)
        self.assertGreaterEqual(len(planned.negative_points), 4)
        for point in planned.positive_points:
            normalized = (point[0] / 200, point[1] / 100)
            self.assertTrue(planned.contains_lasso_point(normalized))
        for point in planned.negative_points:
            normalized = (point[0] / 200, point[1] / 100)
            self.assertFalse(planned.contains_lasso_point(normalized))

    def test_explicit_box_and_points_are_preserved(self) -> None:
        planned = build_pixel_prompt(
            InstancePrompt(
                box=(0.2, 0.25, 0.5, 0.4),
                positive_points=((0.3, 0.4),),
                negative_points=((0.9, 0.9),),
            ),
            width=100,
            height=50,
        )

        self.assertEqual(planned.source, "box+points")
        self.assertEqual(planned.box, (20.0, 12.5, 70.0, 32.5))
        self.assertIn((30.0, 20.0), planned.positive_points)
        self.assertIn((90.0, 45.0), planned.negative_points)


class RleTests(unittest.TestCase):
    def test_round_trips_coco_uncompressed_column_major_runs(self) -> None:
        mask = np.array([
            [False, True, False],
            [True, True, False],
        ], dtype=np.bool_)

        encoded = encode_uncompressed_rle(mask)
        restored = decode_uncompressed_rle(encoded)

        self.assertEqual(encoded["size"], [2, 3])
        self.assertEqual(encoded["counts"], [1, 3, 2])
        np.testing.assert_array_equal(restored, mask)


class EngineTests(unittest.TestCase):
    def test_segments_two_detected_pets_in_one_box_batch_and_preserves_alignment(self) -> None:
        first = np.zeros((60, 80), dtype=np.float32)
        first[8:50, 4:34] = 0.98
        second = np.zeros((60, 80), dtype=np.float32)
        second[12:55, 44:77] = 0.96
        backend = FakeBackend(BackendPrediction(
            masks=np.stack([first, second]),
            predicted_ious=np.array([0.94, 0.88], dtype=np.float32),
            inference_ms=17.0,
            device="cuda:0",
        ))
        detector = FakeDetector(GroundingPrediction(
            detections=(
                Detection(box=(3.0, 6.0, 36.0, 53.0), score=0.93, label="a cat"),
                Detection(box=(42.0, 9.0, 79.0, 58.0), score=0.86, label="a cat"),
            ),
            inference_ms=11.0,
            device="cuda:0",
        ))
        engine = Sam2SegmentationEngine(backend, detector)
        grounded_request = SegmentationRequest(
            capabilities=("subject-segmentation", "edge-thin-structure"),
            image_type_hint="pet",
            prompt=InstancePrompt(labels=("a cat",)),
            source_id="two-cats",
            automatic_detection=True,
        )

        result = engine.analyze(source_png(), grounded_request)

        self.assertEqual(len(result.instances), 2)
        self.assertEqual([item.instance_id for item in result.instances], ["pet-01", "pet-02"])
        self.assertEqual([item.label for item in result.instances], ["a cat", "a cat"])
        self.assertEqual([item.detection_score for item in result.instances], [0.93, 0.86])
        self.assertEqual([item.mask.shape for item in result.instances], [(60, 80), (60, 80)])
        self.assertTrue(result.instances[0].mask[20, 15])
        self.assertFalse(result.instances[0].mask[20, 60])
        self.assertTrue(result.instances[1].mask[20, 60])
        self.assertFalse(result.instances[1].mask[20, 15])
        self.assertEqual(detector.calls, [((80, 60), ("a cat",))])
        self.assertEqual(backend.box_calls, [(
            (3.0, 6.0, 36.0, 53.0),
            (42.0, 9.0, 79.0, 58.0),
        )])
        self.assertEqual(result.subject_mask.shape, (60, 80))
        self.assertTrue(result.subject_mask[20, 15])
        self.assertTrue(result.subject_mask[20, 60])

    def test_skips_an_empty_instance_mask_and_keeps_the_remaining_batch(self) -> None:
        empty = np.zeros((60, 80), dtype=np.float32)
        cat = np.zeros((60, 80), dtype=np.float32)
        cat[12:54, 42:76] = 0.97
        backend = FakeBackend(BackendPrediction(
            masks=np.stack([empty, cat]),
            predicted_ious=np.array([0.91, 0.89], dtype=np.float32),
            inference_ms=14.0,
            device="cuda:0",
        ))
        detector = FakeDetector(GroundingPrediction(
            detections=(
                Detection(box=(3.0, 6.0, 36.0, 53.0), score=0.93, label="a cat"),
                Detection(box=(40.0, 9.0, 79.0, 58.0), score=0.87, label="a cat"),
            ),
            inference_ms=9.0,
            device="cuda:0",
        ))
        engine = Sam2SegmentationEngine(backend, detector)
        grounded_request = SegmentationRequest(
            capabilities=("subject-segmentation", "edge-thin-structure"),
            image_type_hint="pet",
            prompt=InstancePrompt(labels=("a cat",)),
            source_id="one-empty-mask",
            automatic_detection=True,
        )

        result = engine.analyze(source_png(), grounded_request)

        self.assertEqual(len(result.instances), 1)
        self.assertEqual(result.instances[0].instance_id, "pet-01")
        self.assertEqual(result.instances[0].detection_box, (40.0, 9.0, 79.0, 58.0))
        self.assertTrue(result.subject_mask[20, 60])
        self.assertFalse(result.subject_mask[20, 15])

    def test_grounded_detection_rejects_empty_and_misaligned_results(self) -> None:
        empty_detector = FakeDetector(GroundingPrediction(
            detections=(),
            inference_ms=3.0,
            device="cpu",
        ))
        backend = FakeBackend(BackendPrediction(
            masks=np.zeros((1, 60, 80), dtype=np.float32),
            predicted_ious=np.array([0.8], dtype=np.float32),
            inference_ms=4.0,
            device="cpu",
        ))
        engine = Sam2SegmentationEngine(backend, empty_detector)
        grounded_request = SegmentationRequest(
            capabilities=("subject-segmentation",),
            image_type_hint="pet",
            prompt=InstancePrompt(labels=("a cat",)),
            automatic_detection=True,
        )
        with self.assertRaisesRegex(RuntimeError, "no matching"):
            engine.analyze(source_png(), grounded_request)

        two_detections = FakeDetector(GroundingPrediction(
            detections=(
                Detection(box=(2.0, 3.0, 30.0, 45.0), score=0.9, label="a cat"),
                Detection(box=(40.0, 5.0, 76.0, 54.0), score=0.8, label="a cat"),
            ),
            inference_ms=3.0,
            device="cpu",
        ))
        misaligned = Sam2SegmentationEngine(backend, two_detections)
        with self.assertRaisesRegex(RuntimeError, "count or dimensions"):
            misaligned.analyze(source_png(), grounded_request)

    def test_selects_the_highest_quality_mask_and_reports_crop_and_diagnostics(self) -> None:
        weak = np.zeros((60, 80), dtype=np.float32)
        weak[20:40, 25:55] = 0.85
        strong = np.zeros((60, 80), dtype=np.float32)
        strong[8:52, 12:68] = 0.96
        backend = FakeBackend(BackendPrediction(
            masks=np.stack([weak, strong]),
            predicted_ious=np.array([0.55, 0.91], dtype=np.float32),
            inference_ms=18.5,
            device="cuda:0",
        ))
        engine = Sam2SegmentationEngine(backend)

        result = engine.segment(source_png(), request(InstancePrompt(
            lasso=((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)),
            positive_points=((0.5, 0.5),),
            negative_points=((0.98, 0.5),),
            selected_instance_id="cat-a",
        )))

        self.assertEqual(result.mask.shape, (60, 80))
        self.assertGreater(result.predicted_iou, 0.9)
        self.assertGreater(result.stability_score, 0.9)
        self.assertEqual(result.importance_map.shape, (60, 80))
        self.assertGreater(float(result.importance_map.max()), 0.8)
        self.assertLess(float(result.importance_map[30, 40]), 0.2)
        self.assertEqual(result.device, "cuda:0")
        self.assertEqual(result.instance_id, "cat-a")
        self.assertLessEqual(result.crop[0], 12)
        self.assertLessEqual(result.crop[1], 8)
        self.assertGreaterEqual(result.crop[2], 56)
        self.assertGreaterEqual(result.crop[3], 44)
        self.assertEqual(backend.last_image.size, (80, 60))

    def test_prefers_a_mask_contained_by_the_coarse_lasso_when_iou_is_tied(self) -> None:
        contained = np.zeros((60, 80), dtype=np.float32)
        contained[16:44, 24:56] = 0.96
        leaking = np.zeros((60, 80), dtype=np.float32)
        leaking[14:46, 4:36] = 0.96
        backend = FakeBackend(BackendPrediction(
            masks=np.stack([leaking, contained]),
            predicted_ious=np.array([0.9, 0.9], dtype=np.float32),
            inference_ms=10.0,
            device="cuda:0",
        ))
        engine = Sam2SegmentationEngine(backend)

        result = engine.segment(source_png(), request(InstancePrompt(
            lasso=((0.2, 0.15), (0.8, 0.15), (0.8, 0.85), (0.2, 0.85)),
        )))

        self.assertGreater(result.lasso_containment, 0.99)
        self.assertTrue(result.mask[30, 40])
        self.assertFalse(result.mask[30, 8])

    def test_normalizes_confidence_when_box_and_points_have_no_lasso_metric(self) -> None:
        mask = np.zeros((60, 80), dtype=np.float32)
        mask[12:48, 16:64] = 1.0
        backend = FakeBackend(BackendPrediction(
            masks=mask[np.newaxis, ...],
            predicted_ious=np.array([1.0], dtype=np.float32),
            inference_ms=8.0,
            device="cuda:0",
        ))
        engine = Sam2SegmentationEngine(backend)

        result = engine.segment(source_png(), request(InstancePrompt(
            box=(0.2, 0.2, 0.6, 0.6),
            positive_points=((0.5, 0.5),),
            negative_points=((0.05, 0.05),),
        )))

        self.assertAlmostEqual(result.confidence, 1.0)
        self.assertEqual(result.lasso_containment, 0.5)

    def test_rejects_backend_shapes_that_differ_from_the_source(self) -> None:
        backend = FakeBackend(BackendPrediction(
            masks=np.zeros((1, 20, 20), dtype=np.float32),
            predicted_ious=np.array([0.8], dtype=np.float32),
            inference_ms=4.0,
            device="cpu",
        ))
        engine = Sam2SegmentationEngine(backend)

        with self.assertRaisesRegex(RuntimeError, "dimensions"):
            engine.segment(
                source_png(),
                request(InstancePrompt(positive_points=((0.5, 0.5),))),
            )


class FakeBatchEncoding(dict):
    def to(self, _device):
        return self


class FakeGroundingProcessor:
    def __init__(self) -> None:
        self.text = None
        self.target_sizes = None

    def __call__(self, *, images, text, return_tensors):
        self.text = text
        self.image_size = images.size
        self.return_tensors = return_tensors
        return FakeBatchEncoding(input_ids=np.array([[1, 2, 3]], dtype=np.int64))

    def post_process_grounded_object_detection(
        self,
        outputs,
        input_ids,
        threshold,
        text_threshold,
        target_sizes,
    ):
        self.target_sizes = target_sizes
        self.threshold = threshold
        self.text_threshold = text_threshold
        return [{
            "scores": np.array([0.91, 0.84], dtype=np.float32),
            "boxes": np.array([
                [4.0, 5.0, 30.0, 40.0],
                [40.0, 7.0, 76.0, 52.0],
            ], dtype=np.float32),
            "text_labels": ["a cat", "a dog"],
            "labels": ["legacy-cat", "legacy-dog"],
        }]


class FakeGroundingModel:
    def __call__(self, **_inputs):
        return object()


class GroundingDinoBackendTests(unittest.TestCase):
    def test_normalizes_articles_case_and_periods_for_grounding_queries(self) -> None:
        self.assertEqual(
            normalize_detection_labels(("A CAT.", "an Owl", "the rabbit", "pet")),
            ("cat", "owl", "rabbit", "pet"),
        )

    def test_class_agnostic_nms_keeps_the_highest_scoring_overlapping_pet(self) -> None:
        detections = (
            Detection(box=(5.0, 6.0, 35.0, 46.0), score=0.88, label="a pet"),
            Detection(box=(4.0, 5.0, 36.0, 47.0), score=0.94, label="a cat"),
            Detection(box=(45.0, 8.0, 76.0, 52.0), score=0.81, label="a cat"),
        )

        selected = stable_detection_nms(detections, iou_threshold=0.7, maximum=16)

        self.assertEqual([item.label for item in selected], ["a cat", "a cat"])
        self.assertEqual([item.score for item in selected], [0.94, 0.81])

    def test_uses_candidate_labels_and_prefers_text_labels_with_height_width_target(self) -> None:
        processor = FakeGroundingProcessor()
        backend = TransformersGroundingDinoBackend(device="cpu")
        backend._model = FakeGroundingModel()
        backend._processor = processor
        backend._device = "cpu"

        prediction = backend.detect(
            Image.new("RGB", (80, 60), "white"),
            ("A CAT", "a dog"),
        )

        self.assertEqual(processor.text, ["cat", "dog"])
        self.assertEqual(processor.target_sizes, [(60, 80)])
        self.assertEqual([item.label for item in prediction.detections], ["a cat", "a dog"])
        self.assertEqual(
            [item.box for item in prediction.detections],
            [(4.0, 5.0, 30.0, 40.0), (40.0, 7.0, 76.0, 52.0)],
        )
        self.assertAlmostEqual(prediction.detections[0].score, 0.91, places=5)


class InstanceMaskNmsTests(unittest.TestCase):
    @staticmethod
    def instance(
        instance_id: str,
        mask: np.ndarray,
        confidence: float,
    ) -> SegmentationResult:
        return SegmentationResult(
            mask=mask,
            importance_map=np.zeros(mask.shape, dtype=np.float32),
            confidence=confidence,
            predicted_iou=confidence,
            stability_score=0.96,
            prompt_agreement=1.0,
            lasso_containment=0.5,
            crop=(0, 0, mask.shape[1], mask.shape[0]),
            instance_id=instance_id,
            label="cat",
            prompt_source="text+box",
            positive_point_count=0,
            negative_point_count=0,
            mask_area_ratio=float(mask.mean()),
            inference_ms=5.0,
            device="cpu",
            detection_score=confidence,
        )

    def test_removes_a_lower_quality_mask_that_repeats_the_same_pet(self) -> None:
        primary = np.zeros((60, 80), dtype=np.bool_)
        duplicate = np.zeros((60, 80), dtype=np.bool_)
        neighbor = np.zeros((60, 80), dtype=np.bool_)
        primary[8:52, 8:36] = True
        duplicate[9:51, 9:35] = True
        neighbor[8:52, 45:73] = True

        selected = stable_instance_mask_nms((
            self.instance("pet-01", primary, 0.94),
            self.instance("pet-02", neighbor, 0.9),
            self.instance("pet-03", duplicate, 0.72),
        ))

        self.assertEqual([item.instance_id for item in selected], ["pet-01", "pet-02"])

    def test_keeps_touching_pets_when_each_mask_retains_its_own_area(self) -> None:
        left = np.zeros((60, 80), dtype=np.bool_)
        right = np.zeros((60, 80), dtype=np.bool_)
        left[8:52, 5:43] = True
        right[8:52, 37:75] = True

        selected = stable_instance_mask_nms((
            self.instance("pet-01", left, 0.92),
            self.instance("pet-02", right, 0.9),
        ))

        self.assertEqual([item.instance_id for item in selected], ["pet-01", "pet-02"])


class StableInstanceGeometryOrderTests(unittest.TestCase):
    @staticmethod
    def instance(
        instance_id: str,
        box: tuple[float, float, float, float],
        score: float,
        *,
        label: str = "cat",
    ) -> SegmentationResult:
        mask = np.zeros((100, 160), dtype=np.bool_)
        left, top, right, bottom = (int(round(value)) for value in box)
        mask[top:bottom, left:right] = True
        return SegmentationResult(
            mask=mask,
            importance_map=np.zeros(mask.shape, dtype=np.float32),
            confidence=score,
            predicted_iou=score,
            stability_score=0.96,
            prompt_agreement=1.0,
            lasso_containment=0.5,
            crop=(left, top, right - left, bottom - top),
            instance_id=instance_id,
            label=label,
            prompt_source="text+box",
            positive_point_count=0,
            negative_point_count=0,
            mask_area_ratio=float(mask.mean()),
            inference_ms=5.0,
            device="cpu",
            detection_box=box,
            detection_score=score,
        )

    def test_orders_same_row_pets_left_to_right_even_when_scores_swap(self) -> None:
        left = self.instance("high-score-left", (8, 12, 58, 82), 0.97)
        right = self.instance("low-score-right", (92, 10, 150, 84), 0.72)
        first = stable_instance_geometry_order((right, left))

        left_changed = self.instance("low-score-left", (8, 12, 58, 82), 0.68)
        right_changed = self.instance("high-score-right", (92, 10, 150, 84), 0.99)
        second = stable_instance_geometry_order((left_changed, right_changed))

        self.assertEqual([item.crop[0] for item in first], [8, 92])
        self.assertEqual([item.crop[0] for item in second], [8, 92])

    def test_orders_rows_top_to_bottom_then_pets_left_to_right(self) -> None:
        top_right = self.instance("top-right", (82, 8, 142, 44), 0.9)
        bottom_left = self.instance("bottom-left", (10, 60, 60, 94), 0.95)
        top_left = self.instance("top-left", (8, 12, 62, 48), 0.7)

        ordered = stable_instance_geometry_order((bottom_left, top_right, top_left))

        self.assertEqual(
            [item.instance_id for item in ordered],
            ["top-left", "top-right", "bottom-left"],
        )


if __name__ == "__main__":
    unittest.main()
