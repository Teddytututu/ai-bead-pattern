import unittest

from sam2_sidecar.contracts import (
    DEFAULT_DETECTION_LABELS,
    GROUNDED_MODEL_DESCRIPTOR,
    GROUNDED_MODEL_IDENTITY,
    MODEL_DESCRIPTOR,
    MODEL_IDENTITY,
    SegmentationRequest,
)


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["subject-segmentation", "edge-thin-structure"],
        "model": MODEL_IDENTITY,
        "imageTypeHint": "pet",
        "instancePrompt": {
            "lasso": [
                {"x": 0.12, "y": 0.15},
                {"x": 0.82, "y": 0.18},
                {"x": 0.75, "y": 0.88},
                {"x": 0.16, "y": 0.84},
            ],
            "positivePoints": [{"x": 0.48, "y": 0.5}],
            "negativePoints": [{"x": 0.95, "y": 0.5}],
            "labels": ["cat"],
            "selectedInstanceId": "cat-left",
        },
    }


class SegmentationRequestTests(unittest.TestCase):
    def test_pins_runtime_source_and_upstream_sam2_source_separately(self) -> None:
        self.assertEqual(
            MODEL_IDENTITY["sourceRevision"],
            "93c8b7b485963a10800c91f55304db6be211c2bd",
        )
        self.assertEqual(
            MODEL_DESCRIPTOR["upstreamSourceRevision"],
            "2b90b9f5ceec907a1c18123530e92e794ad901a4",
        )

    def test_pins_grounding_dino_and_grounded_sam2_pipeline(self) -> None:
        self.assertEqual(
            GROUNDED_MODEL_DESCRIPTOR["upstreamGroundingDinoSourceRevision"],
            "856dde20aee659246248e20734ef9ba5214f5e44",
        )
        self.assertEqual(
            GROUNDED_MODEL_DESCRIPTOR["upstreamGroundedSam2SourceRevision"],
            "dd4c5141b75e4838dd486c64f773c43b4db3a07b",
        )
        self.assertEqual(
            GROUNDED_MODEL_DESCRIPTOR["components"][0]["weightRevision"],
            "hf:a2bb814dd30d776dcf7e30523b00659f4f141c71",
        )
        self.assertEqual(
            DEFAULT_DETECTION_LABELS,
            ("a cat", "a dog", "a rabbit", "a pet"),
        )

    def test_grounded_identity_accepts_labels_only_and_uses_default_labels(self) -> None:
        payload = request_payload()
        payload["model"] = GROUNDED_MODEL_IDENTITY
        payload["instancePrompt"] = {"labels": ["A CAT", "a dog"]}

        parsed = SegmentationRequest.from_wire(payload)

        self.assertTrue(parsed.automatic_detection)
        self.assertEqual(parsed.prompt.labels, ("A CAT", "a dog"))

        payload.pop("instancePrompt")
        parsed_default = SegmentationRequest.from_wire(payload)
        self.assertEqual(parsed_default.prompt.labels, DEFAULT_DETECTION_LABELS)

    def test_labels_only_remains_grounded_specific_and_empty_labels_are_rejected(self) -> None:
        payload = request_payload()
        payload["instancePrompt"] = {"labels": ["cat"]}
        with self.assertRaisesRegex(ValueError, "positive guidance"):
            SegmentationRequest.from_wire(payload)

        payload["model"] = GROUNDED_MODEL_IDENTITY
        payload["instancePrompt"] = {"labels": []}
        with self.assertRaisesRegex(ValueError, "1..16"):
            SegmentationRequest.from_wire(payload)

    def test_accepts_lasso_box_points_and_instance_identity(self) -> None:
        payload = request_payload()
        payload["instancePrompt"]["box"] = {
            "x": 0.1,
            "y": 0.1,
            "width": 0.75,
            "height": 0.8,
        }

        parsed = SegmentationRequest.from_wire(payload)

        self.assertEqual(parsed.capabilities, (
            "subject-segmentation",
            "edge-thin-structure",
        ))
        self.assertEqual(parsed.image_type_hint, "pet")
        self.assertEqual(parsed.prompt.selected_instance_id, "cat-left")
        self.assertEqual(parsed.prompt.labels, ("cat",))
        self.assertEqual(len(parsed.prompt.lasso), 4)
        self.assertEqual(parsed.prompt.box, (0.1, 0.1, 0.75, 0.8))

    def test_rejects_model_identity_drift(self) -> None:
        payload = request_payload()
        payload["model"] = {**MODEL_IDENTITY, "weightRevision": "future"}

        with self.assertRaisesRegex(ValueError, "identity"):
            SegmentationRequest.from_wire(payload)

    def test_rejects_degenerate_or_empty_guidance(self) -> None:
        payload = request_payload()
        payload["instancePrompt"] = {
            "lasso": [
                {"x": 0.1, "y": 0.1},
                {"x": 0.2, "y": 0.2},
                {"x": 0.3, "y": 0.3},
            ],
        }
        with self.assertRaisesRegex(ValueError, "area"):
            SegmentationRequest.from_wire(payload)

        payload["instancePrompt"] = {"negativePoints": [{"x": 0.9, "y": 0.9}]}
        with self.assertRaisesRegex(ValueError, "positive guidance"):
            SegmentationRequest.from_wire(payload)

    def test_rejects_out_of_bounds_guidance(self) -> None:
        payload = request_payload()
        payload["instancePrompt"]["box"] = {
            "x": 0.7,
            "y": 0.2,
            "width": 0.4,
            "height": 0.5,
        }

        with self.assertRaisesRegex(ValueError, "bounds"):
            SegmentationRequest.from_wire(payload)


if __name__ == "__main__":
    unittest.main()
