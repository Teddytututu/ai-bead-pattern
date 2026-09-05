import io
import json
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from dinov2_sidecar.app import create_app
from dinov2_sidecar.contracts import MODEL_DESCRIPTOR, MODEL_IDENTITY
from dinov2_sidecar.engine import PairScore, RegionalPairScore


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
    def health(self) -> tuple[str, str]:
        return "ready", "fake DINOv2 model ready"

    def score_pair(self, reference: bytes, candidate: bytes) -> PairScore:
        with Image.open(io.BytesIO(reference)) as uploaded:
            uploaded.load()
        with Image.open(io.BytesIO(candidate)) as uploaded:
            uploaded.load()
        views = tuple(
            RegionalPairScore(
                view=view,
                identity_similarity=0.9 - index * 0.02,
                patch_correspondence=0.86 - index * 0.02,
                critical_patch_retention=0.82 - index * 0.02,
                regional_coverage=0.78 - index * 0.02,
                confidence=0.88,
            )
            for index, view in enumerate(("global", "subject", "head", "critical-local"))
        )
        return PairScore(
            views=views,
            confidence=0.88,
            inference_ms=17.5,
            cache_hits=0,
        )


class DinoApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app(FakeEngine()))

    def test_reports_the_pinned_model_descriptor(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"], MODEL_DESCRIPTOR)

    def test_returns_compact_pair_features_and_structured_regional_comparisons(self) -> None:
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
        self.assertEqual(body["inferenceMs"], 17.5)
        features = body["preferenceFeatures"]
        self.assertEqual(features["scope"], "pair")
        self.assertEqual(features["candidateId"], "candidate-48-quality")
        self.assertEqual(len(features["names"]), 16)
        self.assertEqual(len(features["values"]), 16)
        self.assertEqual(
            [entry["view"] for entry in features["regionalComparisons"]],
            ["global", "subject", "head", "critical-local"],
        )
        self.assertEqual(features["regionalComparisons"][0], {
            "view": "global",
            "identitySimilarity": 0.9,
            "patchCorrespondence": 0.86,
            "criticalPatchRetention": 0.82,
            "regionalCoverage": 0.78,
            "confidence": 0.88,
        })

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
