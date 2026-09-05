import io
import unittest

import numpy as np
from PIL import Image

from openclip_sidecar.engine import OpenClipPairEngine, prepare_image


def image_bytes(size: tuple[int, int], color: tuple[int, int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


class FakeEmbeddingBackend:
    def __init__(self) -> None:
        self.encoded_image_count = 0
        self.encoded_text_count = 0

    def health(self) -> tuple[str, str]:
        return "ready", "fake OpenCLIP backend ready"

    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        self.encoded_image_count += len(images)
        rows = []
        for image in images:
            red, green, blue = image.getpixel((112, 112))
            if red >= green and red >= blue:
                rows.append([1.0, 0.0, 0.0, 0.0])
            elif green >= red and green >= blue:
                rows.append([0.0, 1.0, 0.0, 0.0])
            else:
                rows.append([0.0, 0.0, 1.0, 0.0])
        return np.asarray(rows, dtype=np.float32)

    def encode_texts(self, prompts: tuple[str, ...]) -> np.ndarray:
        self.encoded_text_count += len(prompts)
        rows = []
        for prompt in prompts:
            if "cat" in prompt:
                rows.append([1.0, 0.0, 0.0, 0.0])
            elif "dog" in prompt:
                rows.append([0.0, 1.0, 0.0, 0.0])
            elif "bird" in prompt:
                rows.append([0.0, 0.0, 1.0, 0.0])
            elif "rabbit" in prompt:
                rows.append([0.6, 0.6, 0.0, 0.0])
            else:
                rows.append([0.0, 0.0, 0.0, 1.0])
        return np.asarray(rows, dtype=np.float32)

    @property
    def logit_scale(self) -> float:
        return 10.0


class OpenClipEngineTests(unittest.TestCase):
    def test_ensembles_photo_and_pixel_art_prompts_for_each_subject_class(self) -> None:
        engine = OpenClipPairEngine(backend=FakeEmbeddingBackend())

        self.assertIn("a photo of a cat", engine.class_prompts)
        self.assertIn("pixel art of a cat", engine.class_prompts)

    def test_contains_a_rectangular_subject_on_an_opaque_white_square(self) -> None:
        prepared = prepare_image(image_bytes((100, 50), (220, 20, 30, 255)))

        self.assertEqual(prepared.size, (224, 224))
        self.assertEqual(prepared.mode, "RGB")
        self.assertEqual(prepared.getpixel((112, 20)), (255, 255, 255))
        self.assertEqual(prepared.getpixel((112, 112)), (220, 20, 30))

    def test_composites_transparency_over_white_before_scoring(self) -> None:
        prepared = prepare_image(image_bytes((48, 48), (220, 20, 30, 0)))

        self.assertEqual(prepared.getpixel((112, 112)), (255, 255, 255))

    def test_rejects_image_formats_outside_the_pinned_upload_contract(self) -> None:
        buffer = io.BytesIO()
        Image.new("RGB", (48, 48), (20, 30, 40)).save(buffer, format="GIF")

        with self.assertRaisesRegex(ValueError, "PNG, JPEG, or WebP"):
            prepare_image(buffer.getvalue())

    def test_keeps_image_embeddings_in_the_service_cache(self) -> None:
        backend = FakeEmbeddingBackend()
        engine = OpenClipPairEngine(backend=backend)
        reference = image_bytes((64, 48), (220, 20, 30, 255))
        candidate = image_bytes((48, 64), (210, 20, 30, 255))

        first = engine.score_pair(reference, candidate)
        second = engine.score_pair(reference, candidate)

        self.assertEqual(backend.encoded_image_count, 2)
        self.assertEqual(backend.encoded_text_count, len(engine.class_prompts))
        self.assertEqual(first.semantic_retention, second.semantic_retention)
        self.assertEqual(second.cache_hits, 2)
        self.assertFalse(hasattr(first, "embedding"))

    def test_scores_matching_pet_identity_above_a_bird_like_candidate(self) -> None:
        backend = FakeEmbeddingBackend()
        engine = OpenClipPairEngine(backend=backend)
        cat = image_bytes((64, 64), (220, 20, 30, 255))
        bird_like = image_bytes((64, 64), (20, 30, 220, 255))

        matching = engine.score_pair(cat, cat)
        mismatching = engine.score_pair(cat, bird_like)

        self.assertGreater(matching.semantic_retention, mismatching.semantic_retention)
        self.assertGreater(matching.class_distribution_retention, mismatching.class_distribution_retention)
        self.assertGreater(matching.pet_bird_margin, 0)
        self.assertLess(mismatching.pet_bird_margin, 0)

    def test_keeps_evidence_confidence_independent_from_candidate_quality(self) -> None:
        backend = FakeEmbeddingBackend()
        engine = OpenClipPairEngine(backend=backend)
        cat = image_bytes((64, 64), (220, 20, 30, 255))
        bird_like = image_bytes((64, 64), (20, 30, 220, 255))

        matching = engine.score_pair(cat, cat)
        mismatching = engine.score_pair(cat, bird_like)

        self.assertAlmostEqual(matching.confidence, mismatching.confidence, places=7)
        self.assertGreater(mismatching.confidence, 0.5)

    def test_conditions_the_pet_margin_on_the_source_pet_class(self) -> None:
        engine = OpenClipPairEngine(backend=FakeEmbeddingBackend())
        cat = image_bytes((64, 64), (220, 20, 30, 255))
        dog = image_bytes((64, 64), (20, 220, 30, 255))

        matching = engine.score_pair(cat, cat)
        other_pet = engine.score_pair(cat, dog)

        self.assertGreater(matching.pet_bird_margin, other_pet.pet_bird_margin + 0.5)


if __name__ == "__main__":
    unittest.main()
