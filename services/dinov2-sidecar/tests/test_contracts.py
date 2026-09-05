import unittest

from dinov2_sidecar.contracts import (
    MODEL_DESCRIPTOR,
    MODEL_IDENTITY,
    PairRequest,
)


def request_payload() -> dict:
    return {
        "schemaVersion": "ai-gateway-provider-v1",
        "capabilities": ["embedding", "preference-scoring"],
        "model": MODEL_IDENTITY,
        "sourceId": "source-cat-03",
        "candidateId": "candidate-48-quality",
    }


class PairContractTests(unittest.TestCase):
    def test_accepts_the_pinned_pair_request(self) -> None:
        request = PairRequest.from_wire(request_payload())

        self.assertEqual(request.source_id, "source-cat-03")
        self.assertEqual(request.candidate_id, "candidate-48-quality")
        self.assertEqual(request.capabilities, ("embedding", "preference-scoring"))

    def test_rejects_identity_drift_and_requests_without_pair_scoring(self) -> None:
        drifted = request_payload()
        drifted["model"] = {**MODEL_IDENTITY, "sourceRevision": "future"}
        with self.assertRaisesRegex(ValueError, "identity"):
            PairRequest.from_wire(drifted)

        missing_pair_score = request_payload()
        missing_pair_score["capabilities"] = ["embedding"]
        with self.assertRaisesRegex(ValueError, "preference-scoring"):
            PairRequest.from_wire(missing_pair_score)

    def test_records_the_frozen_vits14_runtime_and_weight_license(self) -> None:
        self.assertEqual(MODEL_DESCRIPTOR["architecture"], "ViT-S/14")
        self.assertEqual(
            MODEL_DESCRIPTOR["sourceRevision"],
            "7764ea0f912e53c92e82eb78a2a1631e92725fc8",
        )
        self.assertEqual(
            MODEL_DESCRIPTOR["weightRevision"],
            "hf:ed25f3a31f01632728cabb09d1542f84ab7b0056",
        )
        self.assertEqual(MODEL_DESCRIPTOR["license"]["spdx"], "Apache-2.0")
        self.assertEqual(MODEL_DESCRIPTOR["weightLicense"]["spdx"], "Apache-2.0")
        self.assertEqual(MODEL_DESCRIPTOR["input"], {
            "width": 224,
            "height": 224,
            "patchSize": 14,
            "colorSpace": "srgb",
            "resizeMode": "contain-white-pad-patch",
        })


if __name__ == "__main__":
    unittest.main()
