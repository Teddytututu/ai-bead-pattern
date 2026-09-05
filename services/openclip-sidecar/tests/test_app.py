import io
import json
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from openclip_sidecar.app import create_app
from openclip_sidecar.contracts import MODEL_DESCRIPTOR, MODEL_IDENTITY
from openclip_sidecar.engine import PairScore


def source_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (220, 180, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["embedding", "preference-scoring"],
        "model": MODEL_IDENTITY,
        "sourceId": "source-cat-03",
        "candidateId": "candidate-48-quality",
    }


class FakeEngine:
    class_prompts = ("a photo of a cat", "a photo of a bird")

    def health(self) -> tuple[str, str]:
        return "ready", "fake model ready"

    def score_pair(self, reference: bytes, candidate: bytes) -> PairScore:
        with Image.open(io.BytesIO(reference)) as uploaded:
            uploaded.load()
        with Image.open(io.BytesIO(candidate)) as uploaded:
            uploaded.load()
        return PairScore(
            semantic_retention=0.82,
            class_distribution_retention=0.76,
            pet_bird_margin=0.41,
            confidence=0.88,
            inference_ms=12.5,
            cache_hits=0,
        )


class OpenClipApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app(FakeEngine()))

    def test_reports_the_pinned_model_descriptor(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"], MODEL_DESCRIPTOR)

    def test_returns_only_compact_pair_features_bound_to_the_candidate(self) -> None:
        image = source_png()
        response = self.client.post(
            "/v1/analyze",
            files={
                "image": ("candidate.png", image, "image/png"),
                "referenceImage": ("source.png", image, "image/png"),
            },
            data={"request": json.dumps(request_payload())},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["model"], MODEL_DESCRIPTOR)
        self.assertEqual(body["inferenceMs"], 12.5)
        self.assertEqual(body["preferenceFeatures"], {
            "names": ["semanticRetention", "classDistributionRetention", "petBirdMargin"],
            "values": [0.82, 0.76, 0.41],
            "confidence": 0.88,
            "scope": "pair",
            "candidateId": "candidate-48-quality",
        })
        self.assertNotIn("embedding", body)
        self.assertNotIn("embedding", body["preferenceFeatures"])

    def test_rejects_model_identity_drift(self) -> None:
        payload = request_payload()
        payload["model"] = {**MODEL_IDENTITY, "weightRevision": "latest"}

        response = self.client.post(
            "/v1/analyze",
            files={
                "image": ("candidate.png", source_png(), "image/png"),
                "referenceImage": ("source.png", source_png(), "image/png"),
            },
            data={"request": json.dumps(payload)},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("identity", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
