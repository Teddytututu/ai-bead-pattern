from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from mmpose_sidecar.app import create_app
from mmpose_sidecar.contracts import MODEL_DESCRIPTOR, MODEL_IDENTITY
from mmpose_sidecar.engine import PoseResult, RtmposeEngine


def source_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (80, 60), (210, 175, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["keypoints"],
        "model": MODEL_IDENTITY,
        "imageTypeHint": "pet",
        "sourceId": "cat-source-01",
        "instancePrompt": {
            "box": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
            "selectedInstanceId": "pet-01",
        },
    }


class FakeEngine:
    def health(self) -> tuple[str, str]:
        return "ready", "fake RTMPose ready"

    def analyze(self, source: bytes, request) -> PoseResult:
        with Image.open(io.BytesIO(source)) as image:
            image.load()
            self.image_size = image.size
        self.request = request
        keypoints = np.stack([
            np.stack([
                np.array([12.0 + index + instance_index, 15.0 + index], dtype=np.float32)
                for index in range(17)
            ])
            for instance_index, _instance in enumerate(request.instances)
        ])
        scores = np.full((len(request.instances), 17), 0.8, dtype=np.float32)
        return PoseResult(keypoints=keypoints, scores=scores, inference_ms=7.5, device="cpu")


class MMPoseApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = FakeEngine()
        self.client = TestClient(create_app(self.engine))

    def test_reports_pinned_model_identity(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"], MODEL_DESCRIPTOR)

    def test_health_route_marks_missing_model_as_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_model = Path(temporary_directory) / "end2end.onnx"
            client = TestClient(create_app(RtmposeEngine(model_path=missing_model)))

            response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "unavailable")
        self.assertIn("mmpose:prefetch", response.json()["message"])

    def test_returns_instance_scoped_ap10k_landmarks(self) -> None:
        response = self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": json.dumps(request_payload())},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["providerId"], "mmpose-animal-local")
        self.assertEqual(body["capabilities"], ["keypoints"])
        self.assertEqual(body["analysis"]["landmarks"][0]["id"], "pet-01:left-eye-center")
        self.assertEqual(body["analysis"]["landmarks"][4]["structuralRole"], "tail-root")
        self.assertEqual(body["analysis"]["modelVersions"]["keypoints"], MODEL_DESCRIPTOR["weightRevision"])
        self.assertEqual(self.engine.image_size, (80, 60))

    def test_rejects_oversized_request_metadata(self) -> None:
        response = self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": "{" + ("x" * 70000)},
        )

        self.assertEqual(response.status_code, 413)

    def test_returns_one_landmark_set_for_each_detected_instance(self) -> None:
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

        response = self.client.post(
            "/v1/analyze",
            files={"image": ("cats.png", source_png(), "image/png")},
            data={"request": json.dumps(payload)},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["analysis"]["landmarks"]), 34)
        self.assertEqual(body["analysis"]["landmarks"][17]["id"], "pet-02:left-eye-center")
        self.assertEqual(body["warnings"][0], "instanceCount=2")


if __name__ == "__main__":
    unittest.main()
