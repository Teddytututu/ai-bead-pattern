import unittest
from unittest.mock import patch

from PIL import Image

from pixel_proposal_sidecar.contracts import ProposalRequest, contain_source_frame
from pixel_proposal_sidecar.engine import (
    GeneratedProposal,
    InProcessPixelPipeline,
    PixelProposalEngine,
)


class IsolatedEngineTests(unittest.TestCase):
    def test_records_the_actual_contained_source_rectangle_on_the_model_canvas(self) -> None:
        pipeline = InProcessPixelPipeline()

        canvas, frame = pipeline._prepare_canvas(Image.new("RGB", (80, 40)))

        self.assertEqual(canvas.size, (512, 512))
        self.assertEqual(frame.to_wire(), {
            "fit": "contain",
            "sourceWidth": 80,
            "sourceHeight": 40,
            "x": 0.0,
            "y": 128.0,
            "width": 512.0,
            "height": 256.0,
        })

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
                source_frame=contain_source_frame((80, 60), (96, 96)),
            ), 10.0

        engine = PixelProposalEngine()
        with patch.object(PixelProposalEngine, "_run_worker", side_effect=fake_worker):
            proposals, elapsed_ms = engine.generate(b"cat-source", request)

        self.assertEqual(len(set(observed_seeds)), 2)
        self.assertEqual([proposal.confidence for proposal in proposals], [0.8, 0.72])
        self.assertEqual(elapsed_ms, 20.0)
        self.assertEqual(engine.health()[0], "ready")
        self.assertEqual(proposals[0].source_frame.to_wire()["y"], 12.0)


if __name__ == "__main__":
    unittest.main()
