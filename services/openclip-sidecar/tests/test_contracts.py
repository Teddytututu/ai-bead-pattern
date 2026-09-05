import unittest

from openclip_sidecar.contracts import (
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

        self.assertEqual(request.candidate_id, "candidate-48-quality")
        self.assertEqual(request.source_id, "source-cat-03")
        self.assertEqual(request.capabilities, ("embedding", "preference-scoring"))

    def test_rejects_identity_drift_and_requests_without_pair_scoring(self) -> None:
        drifted = request_payload()
        drifted["model"] = {**MODEL_IDENTITY, "modelVersion": "future"}
        with self.assertRaisesRegex(ValueError, "identity"):
            PairRequest.from_wire(drifted)

        missing_pair_score = request_payload()
        missing_pair_score["capabilities"] = ["embedding"]
        with self.assertRaisesRegex(ValueError, "preference-scoring"):
            PairRequest.from_wire(missing_pair_score)

    def test_requires_a_bounded_candidate_identity(self) -> None:
        missing_candidate = request_payload()
        missing_candidate.pop("candidateId")
        with self.assertRaisesRegex(ValueError, "candidate"):
            PairRequest.from_wire(missing_candidate)

    def test_rejects_non_text_capabilities_as_a_bounded_contract_error(self) -> None:
        malformed = request_payload()
        malformed["capabilities"] = [{"name": "preference-scoring"}]

        with self.assertRaisesRegex(ValueError, "capabilities"):
            PairRequest.from_wire(malformed)

    def test_records_the_frozen_runtime_weight_license_and_input_contract(self) -> None:
        self.assertEqual(MODEL_DESCRIPTOR["modelVersion"], "open_clip_torch-3.3.0")
        self.assertEqual(
            MODEL_DESCRIPTOR["weightRevision"],
            "hf:1a25a446712ba5ee05982a381eed697ef9b435cf",
        )
        self.assertEqual(MODEL_DESCRIPTOR["license"]["spdx"], "MIT")
        self.assertEqual(MODEL_DESCRIPTOR["weightLicense"]["spdx"], "MIT")
        self.assertEqual(MODEL_DESCRIPTOR["defaultPrecision"], "fp32")
        self.assertEqual(MODEL_DESCRIPTOR["input"], {
            "width": 224,
            "height": 224,
            "colorSpace": "srgb",
            "resizeMode": "contain-white",
        })


if __name__ == "__main__":
    unittest.main()
