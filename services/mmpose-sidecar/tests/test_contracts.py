from __future__ import annotations

import unittest

from mmpose_sidecar.contracts import MODEL_DESCRIPTOR, MODEL_IDENTITY, PoseRequest


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["keypoints"],
        "model": MODEL_IDENTITY,
        "imageTypeHint": "pet",
        "sourceId": "cat-source-01",
        "instancePrompt": {
            "box": {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.6},
            "selectedInstanceId": "pet-02",
        },
    }


class PoseRequestTests(unittest.TestCase):
    def test_pins_the_real_256_square_onnx_contract(self) -> None:
        self.assertEqual(MODEL_DESCRIPTOR["input"]["preferredWidth"], 256)
        self.assertEqual(MODEL_DESCRIPTOR["input"]["preferredHeight"], 256)
        self.assertEqual(MODEL_DESCRIPTOR["input"]["simccSplitRatio"], 2.0)
        self.assertEqual(
            MODEL_IDENTITY["weightRevision"],
            "sha256:1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28",
        )

    def test_parses_instance_box_and_stable_pet_identity(self) -> None:
        request = PoseRequest.from_wire(request_payload())

        self.assertEqual(request.instance_id, "pet-02")
        self.assertEqual(request.box, (0.1, 0.2, 0.7, 0.6))
        self.assertEqual(request.source_id, "cat-source-01")

    def test_uses_full_frame_and_first_pet_identity_without_a_prompt(self) -> None:
        payload = request_payload()
        payload.pop("instancePrompt")

        request = PoseRequest.from_wire(payload)

        self.assertEqual(request.instance_id, "pet-01")
        self.assertEqual(request.box, (0.0, 0.0, 1.0, 1.0))

    def test_rejects_model_identity_drift(self) -> None:
        payload = request_payload()
        payload["model"] = {**MODEL_IDENTITY, "weightRevision": "latest"}

        with self.assertRaisesRegex(ValueError, "identity"):
            PoseRequest.from_wire(payload)

    def test_rejects_noncanonical_instance_identity(self) -> None:
        payload = request_payload()
        payload["instancePrompt"]["selectedInstanceId"] = "left cat"

        with self.assertRaisesRegex(ValueError, "pet instance"):
            PoseRequest.from_wire(payload)

    def test_parses_a_bounded_batch_of_detected_pet_instances(self) -> None:
        payload = request_payload()
        payload.pop("instancePrompt")
        payload["instancePrompts"] = [
            {
                "box": {"x": 0.05, "y": 0.1, "width": 0.4, "height": 0.75},
                "selectedInstanceId": "pet-01",
                "labels": ["cat"],
            },
            {
                "box": {"x": 0.52, "y": 0.12, "width": 0.43, "height": 0.72},
                "selectedInstanceId": "pet-02",
                "labels": ["cat"],
            },
        ]

        request = PoseRequest.from_wire(payload)

        self.assertEqual([instance.instance_id for instance in request.instances], ["pet-01", "pet-02"])
        self.assertEqual(request.instances[1].box, (0.52, 0.12, 0.43, 0.72))

    def test_rejects_duplicate_instance_ids_in_a_batch(self) -> None:
        payload = request_payload()
        prompt = payload.pop("instancePrompt")
        payload["instancePrompts"] = [prompt, prompt]

        with self.assertRaisesRegex(ValueError, "unique"):
            PoseRequest.from_wire(payload)


if __name__ == "__main__":
    unittest.main()
