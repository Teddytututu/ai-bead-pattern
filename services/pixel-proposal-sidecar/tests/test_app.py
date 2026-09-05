import base64
import io
import json
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from pixel_proposal_sidecar.app import create_app
from pixel_proposal_sidecar.contracts import MODEL_IDENTITY
from pixel_proposal_sidecar.contracts import contain_source_frame
from pixel_proposal_sidecar.engine import GeneratedProposal


class FakeEngine:
    def health(self) -> tuple[str, str]:
        return "ready", "fake model ready"

    def generate(self, source: bytes, request):
        with Image.open(io.BytesIO(source)) as uploaded:
            uploaded.load()
        output = Image.new("RGBA", (96, 96), (50, 100, 150, 255))
        return [GeneratedProposal(
            proposal_id=f"{request.kind}-123",
            image=output,
            confidence=0.87,
            seed=123,
            source_frame=contain_source_frame((uploaded.width, uploaded.height), output.size),
        )], 12.5


def request_payload(kind: str = "learned-pixelization") -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": [kind],
        "model": MODEL_IDENTITY,
        "targetGrid": {"width": 48, "height": 48},
        "styleId": "faithful",
    }


def source_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (220, 180, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


class ProposalApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app(FakeEngine()))

    def test_reports_pinned_health_identity(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"], MODEL_IDENTITY)

    def test_returns_replayable_raw_rgba_proposals(self) -> None:
        response = self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": json.dumps(request_payload("generative-proposal"))},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["capabilities"], ["generative-proposal"])
        proposal = body["learnedProposals"][0]
        self.assertEqual(proposal["targetGrid"], {"width": 48, "height": 48})
        self.assertEqual(proposal["sourceFrame"], {
            "fit": "contain",
            "sourceWidth": 64,
            "sourceHeight": 48,
            "x": 0.0,
            "y": 12.0,
            "width": 96.0,
            "height": 72.0,
        })
        self.assertEqual(len(base64.b64decode(proposal["image"]["rgbaBase64"])), 96 * 96 * 4)

    def test_rejects_model_identity_drift(self) -> None:
        payload = request_payload()
        payload["model"] = {**MODEL_IDENTITY, "modelVersion": "future"}

        response = self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": json.dumps(payload)},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("identity", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
