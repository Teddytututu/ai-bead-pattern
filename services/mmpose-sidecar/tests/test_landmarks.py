from __future__ import annotations

import unittest

import numpy as np

from mmpose_sidecar.landmarks import landmarks_from_ap10k


class LandmarkMappingTests(unittest.TestCase):
    def test_maps_all_ap10k_roles_with_instance_scoped_ids(self) -> None:
        keypoints = np.stack([
            np.array([20.0 + index, 30.0 + index], dtype=np.float32)
            for index in range(17)
        ])[None, :, :]
        scores = np.linspace(0.95, 0.35, 17, dtype=np.float32)[None, :]

        landmarks = landmarks_from_ap10k("pet-03", keypoints, scores)

        self.assertEqual(len(landmarks), 17)
        self.assertEqual(landmarks[0]["id"], "pet-03:left-eye-center")
        self.assertEqual(landmarks[0]["structuralRole"], "eye-center")
        self.assertEqual(landmarks[1]["symmetryGroup"], "pet-03:eyes")
        self.assertEqual(landmarks[2]["id"], "pet-03:nose-tip")
        self.assertEqual(landmarks[4]["structuralRole"], "tail-root")
        self.assertEqual(landmarks[7]["structuralRole"], "front-paw")
        self.assertEqual(landmarks[16]["structuralRole"], "rear-paw")
        self.assertEqual(landmarks[0]["provenance"][0]["origin"], "model")

    def test_low_confidence_keypoint_stays_as_missing_evidence(self) -> None:
        keypoints = np.zeros((1, 17, 2), dtype=np.float32)
        scores = np.full((1, 17), 0.1, dtype=np.float32)

        landmarks = landmarks_from_ap10k("pet-01", keypoints, scores)

        self.assertTrue(all(entry["observationState"] == "missing" for entry in landmarks))
        self.assertTrue(all(entry["affectsOccupancy"] is False for entry in landmarks))


if __name__ == "__main__":
    unittest.main()
