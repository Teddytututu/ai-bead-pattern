import base64
import io
import json
import unittest

import numpy as np
from httpx import ASGITransport, AsyncClient
from PIL import Image

from sam2_sidecar.app import create_app
from sam2_sidecar.contracts import GROUNDED_MODEL_IDENTITY, MODEL_IDENTITY
from sam2_sidecar.engine import SegmentationBatchResult, SegmentationResult


class FakeEngine:
    def health(self) -> tuple[str, str]:
        return "ready", "fake SAM2 ready"

    def grounded_health(self) -> tuple[str, str]:
        return "ready", "fake GroundingDINO and SAM2 ready"

    def analyze(self, source: bytes, request) -> SegmentationBatchResult:
        with Image.open(io.BytesIO(source)) as uploaded:
            width, height = uploaded.size
        automatic = request.automatic_detection
        slices = (
            ((4, 7, 30, height - 5), "pet-01", "a cat", 0.93),
            ((36, 8, width - 3, height - 4), "pet-02", "a cat", 0.86),
        ) if automatic else (
            ((8, 6, width - 8, height - 6), request.prompt.selected_instance_id or "prompt-1",
             request.prompt.labels[0] if request.prompt.labels else None, None),
        )
        instances = []
        for (left, top, right, bottom), instance_id, label, detection_score in slices:
            mask = np.zeros((height, width), dtype=np.bool_)
            mask[top:bottom, left:right] = True
            importance = np.zeros((height, width), dtype=np.float32)
            importance[max(0, top - 1):top + 1, left:right] = 1.0
            instances.append(SegmentationResult(
                mask=mask,
                importance_map=importance,
                confidence=0.9,
                predicted_iou=0.92,
                stability_score=0.96,
                prompt_agreement=1.0,
                lasso_containment=0.98 if not automatic else 0.5,
                crop=(left, top, right - left, bottom - top),
                detection_box=(left, top, right, bottom) if automatic else None,
                detection_score=detection_score,
                instance_id=instance_id,
                label=label,
                prompt_source="text+box" if automatic else "lasso",
                positive_point_count=0 if automatic else 3,
                negative_point_count=0 if automatic else 4,
                mask_area_ratio=float(mask.mean()),
                inference_ms=13.25,
                device="cuda:0",
            ))
        subject_mask = np.logical_or.reduce([item.mask for item in instances])
        importance_map = np.maximum.reduce([item.importance_map for item in instances])
        return SegmentationBatchResult.from_instances(
            tuple(instances),
            subject_mask=subject_mask,
            importance_map=importance_map,
            inference_ms=24.5 if automatic else 13.25,
        )


def source_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (230, 190, 140)).save(buffer, format="PNG")
    return buffer.getvalue()


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["subject-segmentation", "edge-thin-structure"],
        "model": MODEL_IDENTITY,
        "imageTypeHint": "pet",
        "sourceId": "cat-source",
        "instancePrompt": {
            "lasso": [
                {"x": 0.1, "y": 0.1},
                {"x": 0.9, "y": 0.1},
                {"x": 0.9, "y": 0.9},
                {"x": 0.1, "y": 0.9},
            ],
            "labels": ["cat"],
            "selectedInstanceId": "cat-left",
        },
    }


class Sam2ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = AsyncClient(
            transport=ASGITransport(app=create_app(FakeEngine())),
            base_url="http://test",
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()

    async def test_reports_pinned_health_identity(self) -> None:
        response = await self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"]["modelId"], MODEL_IDENTITY["modelId"])
        self.assertEqual(
            response.json()["model"]["weightRevision"],
            MODEL_IDENTITY["weightRevision"],
        )

        grounded = await self.client.get("/health/grounded")
        self.assertEqual(grounded.status_code, 200)
        self.assertEqual(grounded.json()["model"]["modelId"], GROUNDED_MODEL_IDENTITY["modelId"])

    async def test_returns_compact_mask_evidence_crop_and_instance_quality(self) -> None:
        response = await self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": json.dumps(request_payload())},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        evidence = body["analysis"]["subjectMaskEvidence"]
        self.assertEqual(evidence["source"], "ai")
        self.assertEqual(evidence["mask"]["width"], 64)
        self.assertEqual(evidence["mask"]["height"], 48)
        self.assertIn("rle", evidence["mask"])
        self.assertNotIn("values", evidence["mask"])
        importance = body["analysis"]["importanceMap"]
        self.assertEqual(importance["width"], 64)
        self.assertEqual(importance["height"], 48)
        self.assertEqual(len(base64.b64decode(importance["uint8Base64"])), 64 * 48)
        self.assertEqual(body["analysis"]["suggestedCrop"], {
            "x": 6,
            "y": 4,
            "width": 52,
            "height": 40,
        })
        proposal = body["instanceProposals"][0]
        self.assertEqual(proposal["instanceId"], "cat-left")
        self.assertEqual(proposal["label"], "cat")
        self.assertAlmostEqual(proposal["predictedIoU"], 0.92)
        self.assertAlmostEqual(proposal["stabilityScore"], 0.96)
        self.assertEqual(proposal["diagnostics"]["positivePointCount"], 3)
        self.assertAlmostEqual(proposal["diagnostics"]["lassoContainment"], 0.98)
        self.assertEqual(proposal["diagnostics"]["device"], "cuda:0")

    async def test_returns_two_grounded_instances_semantic_regions_and_union_subject(self) -> None:
        payload = request_payload()
        payload["model"] = GROUNDED_MODEL_IDENTITY
        payload["instancePrompt"] = {"labels": ["A CAT"]}
        response = await self.client.post(
            "/v1/analyze",
            files={"image": ("two-cats.png", source_png(), "image/png")},
            data={"request": json.dumps(payload)},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["providerId"], "grounded-sam2-local")
        self.assertEqual(len(body["instanceProposals"]), 2)
        self.assertEqual(
            [proposal["instanceId"] for proposal in body["instanceProposals"]],
            ["pet-01", "pet-02"],
        )
        self.assertEqual(
            [proposal["label"] for proposal in body["instanceProposals"]],
            ["a cat", "a cat"],
        )
        self.assertEqual(
            [proposal["detectionScore"] for proposal in body["instanceProposals"]],
            [0.93, 0.86],
        )
        self.assertEqual(
            [region["id"] for region in body["analysis"]["semanticRegions"]],
            ["pet-01:subject", "pet-02:subject"],
        )
        for proposal in body["instanceProposals"]:
            self.assertEqual(proposal["maskRle"]["size"], [48, 64])
        union = body["analysis"]["subjectMaskEvidence"]["mask"]
        self.assertEqual(union["width"], 64)
        self.assertEqual(union["height"], 48)
        self.assertEqual(body["analysis"]["suggestedCrop"], {
            "x": 2,
            "y": 5,
            "width": 61,
            "height": 41,
        })

    async def test_rejects_model_identity_drift(self) -> None:
        payload = request_payload()
        payload["model"] = {**MODEL_IDENTITY, "modelVersion": "future"}

        response = await self.client.post(
            "/v1/analyze",
            files={"image": ("cat.png", source_png(), "image/png")},
            data={"request": json.dumps(payload)},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("identity", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
