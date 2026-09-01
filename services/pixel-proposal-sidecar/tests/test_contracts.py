import unittest

from pixel_proposal_sidecar.contracts import (
    MODEL_IDENTITY,
    ProposalRequest,
    deterministic_seeds,
)


class ProposalContractTests(unittest.TestCase):
    def test_accepts_both_routes_and_positive_target_grid(self) -> None:
        learned = ProposalRequest.from_wire({
            "schemaVersion": "ai-gateway-provider-v1",
            "capabilities": ["learned-pixelization"],
            "model": MODEL_IDENTITY,
            "targetGrid": {"width": 48, "height": 48},
            "styleId": "faithful",
        })
        generated = ProposalRequest.from_wire({
            "schemaVersion": "ai-gateway-provider-v1",
            "capabilities": ["generative-proposal"],
            "model": MODEL_IDENTITY,
            "targetGrid": {"width": 64, "height": 64},
        })

        self.assertEqual(learned.kind, "learned-pixelization")
        self.assertEqual(learned.target_grid, (48, 48))
        self.assertEqual(generated.kind, "generative-proposal")

    def test_rejects_identity_drift_and_unsupported_grids(self) -> None:
        with self.assertRaisesRegex(ValueError, "identity"):
            ProposalRequest.from_wire({
                "schemaVersion": "ai-gateway-provider-v1",
                "capabilities": ["learned-pixelization"],
                "model": {**MODEL_IDENTITY, "modelVersion": "future"},
                "targetGrid": {"width": 48, "height": 48},
            })
        with self.assertRaisesRegex(ValueError, "target grid"):
            ProposalRequest.from_wire({
                "schemaVersion": "ai-gateway-provider-v1",
                "capabilities": ["learned-pixelization"],
                "model": MODEL_IDENTITY,
                "targetGrid": {"width": 0, "height": 48},
            })

    def test_derives_replayable_distinct_seeds_for_each_route(self) -> None:
        learned = deterministic_seeds(b"cat-source", "learned-pixelization", 1)
        generated = deterministic_seeds(b"cat-source", "generative-proposal", 3)

        self.assertEqual(learned, deterministic_seeds(b"cat-source", "learned-pixelization", 1))
        self.assertEqual(len(set(generated)), 3)
        self.assertNotEqual(learned[0], generated[0])


if __name__ == "__main__":
    unittest.main()
