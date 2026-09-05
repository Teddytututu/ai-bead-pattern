from __future__ import annotations

import unittest

import numpy as np

from mmpose_sidecar.geometry import decode_simcc, preprocess_instance


class GeometryTests(unittest.TestCase):
    def test_preprocess_preserves_instance_center_and_model_shape(self) -> None:
        image = np.zeros((100, 200, 3), dtype=np.uint8)

        tensor, center, scale = preprocess_instance(
            image,
            (40.0, 20.0, 160.0, 80.0),
        )

        self.assertEqual(tensor.shape, (1, 3, 256, 256))
        np.testing.assert_allclose(center, np.array([100.0, 50.0], dtype=np.float32))
        self.assertAlmostEqual(float(scale[0] / scale[1]), 1.0, places=5)

    def test_decode_maps_simcc_coordinates_back_to_source_box(self) -> None:
        simcc_x = np.zeros((1, 2, 512), dtype=np.float32)
        simcc_y = np.zeros((1, 2, 512), dtype=np.float32)
        simcc_x[0, 0, 128] = 0.8
        simcc_y[0, 0, 128] = 0.7
        simcc_x[0, 1, 384] = 0.6
        simcc_y[0, 1, 384] = 0.9

        keypoints, scores = decode_simcc(
            simcc_x,
            simcc_y,
            model_input_size=(256, 256),
            center=np.array([100.0, 50.0], dtype=np.float32),
            scale=np.array([160.0, 160.0], dtype=np.float32),
        )

        np.testing.assert_allclose(keypoints[0, 0], np.array([60.0, 10.0]), atol=1e-5)
        np.testing.assert_allclose(keypoints[0, 1], np.array([140.0, 90.0]), atol=1e-5)
        np.testing.assert_allclose(scores[0], np.array([0.7, 0.6]), atol=1e-5)


if __name__ == "__main__":
    unittest.main()
