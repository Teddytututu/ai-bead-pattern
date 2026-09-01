import unittest
from unittest.mock import patch

from PIL import Image

from pixel_proposal_sidecar.contracts import ProposalRequest
from pixel_proposal_sidecar.engine import GeneratedProposal, PixelProposalEngine


class IsolatedEngineTests(unittest.TestCase):
    def test_runs_each_generative_seed_in_a_separate_worker(self) -> None:
        request = ProposalRequest(
            kind="generative-proposal",
            target_grid=(48, 48),
            style_id="cute",
        )
        observed_seeds: list[int] = []

        def fake_worker(source: bytes, _request: ProposalRequest, seed: int):
            self.assertEqual(source, b"cat-source")
            observed_seeds.append(seed)
            return GeneratedProposal(
                proposal_id=f"proposal-{seed}",
                image=Image.new("RGBA", (96, 96)),
                confidence=0.8,
                seed=seed,
            ), 10.0

        engine = PixelProposalEngine()
        with patch.object(PixelProposalEngine, "_run_worker", side_effect=fake_worker):
            proposals, elapsed_ms = engine.generate(b"cat-source", request)

        self.assertEqual(len(set(observed_seeds)), 2)
        self.assertEqual([proposal.confidence for proposal in proposals], [0.8, 0.72])
        self.assertEqual(elapsed_ms, 20.0)
        self.assertEqual(engine.health()[0], "ready")


if __name__ == "__main__":
    unittest.main()
