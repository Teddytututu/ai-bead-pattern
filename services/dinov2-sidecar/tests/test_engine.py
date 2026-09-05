import io
import unittest

import numpy as np
from PIL import Image

from dinov2_sidecar.engine import (
    DinoEncodedView,
    DinoV2Backend,
    DinoV2PairEngine,
    compare_feature_sets,
    prepare_image,
)


def image_bytes(
    size: tuple[int, int],
    color: tuple[int, int, int, int],
    accent: tuple[int, int, int, int] | None = None,
) -> bytes:
    image = Image.new("RGBA", size, color)
    if accent is not None:
        width, height = size
        for y in range(height // 5, max(height // 5 + 1, height // 2)):
            for x in range(width // 3, max(width // 3 + 1, 2 * width // 3)):
                image.putpixel((x, y), accent)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class FakeDinoBackend:
    def __init__(self) -> None:
        self.encoded_count = 0

    def health(self) -> tuple[str, str]:
        return "ready", "fake DINOv2 backend ready"

    def encode(self, images: list[Image.Image]) -> list[DinoEncodedView]:
        self.encoded_count += len(images)
        encoded: list[DinoEncodedView] = []
        for image in images:
            pixels = np.asarray(image, dtype=np.float32)
            mean = pixels.mean(axis=(0, 1))
            if mean[0] >= mean[1] and mean[0] >= mean[2]:
                global_features = np.asarray([1.0, 0.0, 0.0], dtype=np.float32)
                patch_features = np.asarray([
                    [1.0, 0.0, 0.0],
                    [0.9, 0.1, 0.0],
                    [0.7, 0.3, 0.0],
                    [0.5, 0.5, 0.0],
                ], dtype=np.float32)
            elif mean[1] >= mean[2]:
                global_features = np.asarray([0.0, 1.0, 0.0], dtype=np.float32)
                patch_features = np.asarray([
                    [0.0, 1.0, 0.0],
                    [0.1, 0.9, 0.0],
                    [0.3, 0.7, 0.0],
                    [0.5, 0.5, 0.0],
                ], dtype=np.float32)
            else:
                global_features = np.asarray([0.0, 0.0, 1.0], dtype=np.float32)
                patch_features = np.asarray([
                    [0.0, 0.0, 1.0],
                    [0.0, 0.1, 0.9],
                    [0.0, 0.3, 0.7],
                    [0.0, 0.5, 0.5],
                ], dtype=np.float32)
            encoded.append(DinoEncodedView(global_features, patch_features))
        return encoded


class DinoEngineTests(unittest.TestCase):
    def test_contains_a_rectangular_image_without_stretching_and_uses_patch_multiple(self) -> None:
        prepared = prepare_image(image_bytes((100, 50), (220, 20, 30, 255)))

        self.assertEqual(prepared.size, (224, 224))
        self.assertEqual(prepared.width % 14, 0)
        self.assertEqual(prepared.height % 14, 0)
        self.assertEqual(prepared.getpixel((112, 20)), (255, 255, 255))
        self.assertEqual(prepared.getpixel((112, 112)), (220, 20, 30))

    def test_composites_transparency_over_white_before_feature_extraction(self) -> None:
        prepared = prepare_image(image_bytes((48, 48), (220, 20, 30, 0)))

        self.assertEqual(prepared.getpixel((112, 112)), (255, 255, 255))

    def test_scores_global_subject_head_and_critical_local_views(self) -> None:
        engine = DinoV2PairEngine(backend=FakeDinoBackend())
        source = image_bytes((120, 80), (220, 30, 30, 255), (245, 210, 40, 255))

        score = engine.score_pair(source, source)

        self.assertEqual([view.view for view in score.views], [
            "global", "subject", "head", "critical-local",
        ])
        for view in score.views:
            self.assertGreater(view.identity_similarity, 0.99)
            self.assertGreater(view.patch_correspondence, 0.99)
            self.assertGreater(view.critical_patch_retention, 0.99)
            self.assertGreater(view.regional_coverage, 0.99)
            self.assertGreaterEqual(view.confidence, 0)
            self.assertLessEqual(view.confidence, 1)

    def test_scores_identity_and_patch_retention_below_a_different_candidate(self) -> None:
        engine = DinoV2PairEngine(backend=FakeDinoBackend())
        source = image_bytes((96, 64), (220, 20, 30, 255))
        different = image_bytes((96, 64), (20, 30, 220, 255))

        matching = engine.score_pair(source, source)
        mismatching = engine.score_pair(source, different)

        self.assertGreater(matching.identity_similarity, mismatching.identity_similarity)
        self.assertGreater(matching.patch_correspondence, mismatching.patch_correspondence)
        self.assertGreater(matching.critical_patch_retention, mismatching.critical_patch_retention)
        self.assertGreater(matching.regional_coverage, mismatching.regional_coverage)

    def test_patch_metrics_penalize_collapsed_local_structure(self) -> None:
        source = DinoEncodedView(
            global_features=np.asarray([0.7, 0.7], dtype=np.float32),
            patch_features=np.asarray([
                [1.0, 0.0],
                [0.0, 1.0],
                [0.7, 0.7],
                [0.65, 0.75],
            ], dtype=np.float32),
        )
        complete = DinoEncodedView(
            global_features=np.asarray([0.7, 0.7], dtype=np.float32),
            patch_features=source.patch_features.copy(),
        )
        collapsed = DinoEncodedView(
            global_features=np.asarray([0.7, 0.7], dtype=np.float32),
            patch_features=np.asarray([
                [1.0, 0.0],
                [1.0, 0.0],
                [0.7, 0.7],
                [0.7, 0.7],
            ], dtype=np.float32),
        )

        complete_metrics = compare_feature_sets(source, complete)
        collapsed_metrics = compare_feature_sets(source, collapsed)

        self.assertGreater(complete_metrics.patch_correspondence, collapsed_metrics.patch_correspondence)
        self.assertGreater(complete_metrics.critical_patch_retention, collapsed_metrics.critical_patch_retention)
        self.assertGreater(complete_metrics.regional_coverage, collapsed_metrics.regional_coverage)

    def test_salient_subject_patches_outweigh_matching_letterbox_background(self) -> None:
        source = DinoEncodedView(
            global_features=np.asarray([0.7, 0.7], dtype=np.float32),
            patch_features=np.asarray([
                [1.0, 0.0],
                [1.0, 0.0],
                [0.0, 1.0],
                [0.0, 1.0],
            ], dtype=np.float32),
            patch_salience=np.asarray([0.0, 0.0, 1.0, 1.0], dtype=np.float32),
        )
        background_only = DinoEncodedView(
            global_features=np.asarray([1.0, 0.0], dtype=np.float32),
            patch_features=np.asarray([
                [1.0, 0.0],
                [1.0, 0.0],
                [1.0, 0.0],
                [1.0, 0.0],
            ], dtype=np.float32),
            patch_salience=np.asarray([0.0, 0.0, 1.0, 1.0], dtype=np.float32),
        )

        metrics = compare_feature_sets(source, background_only)

        self.assertLess(metrics.patch_correspondence, 0.8)
        self.assertLess(metrics.critical_patch_retention, 0.8)
        self.assertLess(metrics.regional_coverage, 0.2)

    def test_caches_all_regional_embeddings_for_repeated_pairs(self) -> None:
        backend = FakeDinoBackend()
        engine = DinoV2PairEngine(backend=backend)
        source = image_bytes((80, 60), (220, 20, 30, 255))

        first = engine.score_pair(source, source)
        second = engine.score_pair(source, source)

        self.assertGreaterEqual(backend.encoded_count, 1)
        self.assertLessEqual(backend.encoded_count, 4)
        self.assertEqual(first.identity_similarity, second.identity_similarity)
        self.assertEqual(second.cache_hits, 8)

    def test_health_reports_absent_pinned_weights_as_unavailable(self) -> None:
        class MissingWeightsBackend(DinoV2Backend):
            def _runtime_health(self) -> tuple[bool, str]:
                return True, "runtime ready; device=cpu"

            def _weights_cached(self) -> bool:
                return False

        status, message = MissingWeightsBackend(device="cpu").health()

        self.assertEqual(status, "unavailable")
        self.assertIn("absent", message)

    def test_health_reports_cached_cold_weights_as_degraded(self) -> None:
        class CachedWeightsBackend(DinoV2Backend):
            def _runtime_health(self) -> tuple[bool, str]:
                return True, "runtime ready; device=cpu"

            def _weights_cached(self) -> bool:
                return True

        status, message = CachedWeightsBackend(device="cpu").health()

        self.assertEqual(status, "degraded")
        self.assertIn("first request", message)


if __name__ == "__main__":
    unittest.main()
