from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from mmpose_sidecar.contracts import PoseInstance, PoseRequest
from mmpose_sidecar.engine import RtmposeEngine


def source_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (120, 80), (190, 150, 110)).save(buffer, format="PNG")
    return buffer.getvalue()


class FakeSession:
    def get_inputs(self):
        return [type("Input", (), {"name": "input"})()]

    def get_outputs(self):
        return [type("Output", (), {"name": "simcc_x"})(), type("Output", (), {"name": "simcc_y"})()]

    def run(self, output_names, feed):
        tensor = feed["input"]
        self.tensor_shape = tensor.shape
        count = tensor.shape[0]
        simcc_x = np.zeros((count, 17, 512), dtype=np.float32)
        simcc_y = np.zeros((count, 17, 512), dtype=np.float32)
        simcc_x[:, :, 256] = 0.9
        simcc_y[:, :, 256] = 0.8
        return [simcc_x, simcc_y]


class EngineTests(unittest.TestCase):
    def test_health_distinguishes_missing_cached_and_loaded_model_states(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / "end2end.onnx"
            engine = RtmposeEngine(model_path=model_path, device="cpu")

            self.assertEqual(
                engine.health(),
                ("unavailable", "RTMPose model awaits pnpm mmpose:prefetch"),
            )

            model_path.write_bytes(b"pinned-model-placeholder")
            self.assertEqual(
                engine.health(),
                ("degraded", "RTMPose ONNX loads on first request; device=cpu"),
            )

            engine._session = FakeSession()
            self.assertEqual(
                engine.health(),
                ("ready", "RTMPose ONNX loaded; device=cpu"),
            )

    def test_batches_every_detected_instance_into_one_onnx_call(self) -> None:
        session = FakeSession()
        engine = RtmposeEngine(session=session, device="cpu")
        request = PoseRequest(
            instances=(
                PoseInstance("pet-01", (0.05, 0.1, 0.4, 0.75), "cat"),
                PoseInstance("pet-02", (0.52, 0.12, 0.43, 0.72), "cat"),
            ),
            source_id="two-cats",
        )

        result = engine.analyze(source_png(), request)

        self.assertEqual(session.tensor_shape, (2, 3, 256, 256))
        self.assertEqual(result.keypoints.shape, (2, 17, 2))
        self.assertEqual(result.scores.shape, (2, 17))
        self.assertTrue(np.all(result.scores > 0.79))


if __name__ == "__main__":
    unittest.main()
