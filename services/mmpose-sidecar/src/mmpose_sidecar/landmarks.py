from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .contracts import MODEL_IDENTITY, PROVIDER_ID


@dataclass(frozen=True)
class LandmarkDefinition:
    name: str
    kind: str
    structural_role: str
    priority: str
    symmetry_group: str | None = None
    source_radius: float = 2.0
    grid_radius: float = 0.5
    affects_occupancy: bool = False
    feature_region: str | None = None


AP10K_LANDMARKS = (
    LandmarkDefinition("left-eye-center", "eye", "eye-center", "hard", "eyes", 3.0, 1.0, False, "pet-face"),
    LandmarkDefinition("right-eye-center", "eye", "eye-center", "hard", "eyes", 3.0, 1.0, False, "pet-face"),
    LandmarkDefinition("nose-tip", "nose", "nose-tip", "hard", None, 2.0, 0.5, False, "pet-face"),
    LandmarkDefinition("neck-base", "body", "neck-base", "hard", None, 2.0, 0.5, True),
    LandmarkDefinition("tail-root", "body", "tail-root", "hard", None, 2.0, 0.5, True),
    LandmarkDefinition("left-shoulder", "body", "shoulder", "soft", "shoulders", 2.0, 0.5, True),
    LandmarkDefinition("left-front-knee", "body", "front-knee", "soft", "front-knees", 2.0, 0.5, True),
    LandmarkDefinition("left-front-paw", "body", "front-paw", "hard", "front-paws", 2.0, 0.5, True),
    LandmarkDefinition("right-shoulder", "body", "shoulder", "soft", "shoulders", 2.0, 0.5, True),
    LandmarkDefinition("right-front-knee", "body", "front-knee", "soft", "front-knees", 2.0, 0.5, True),
    LandmarkDefinition("right-front-paw", "body", "front-paw", "hard", "front-paws", 2.0, 0.5, True),
    LandmarkDefinition("left-hip", "body", "hip", "soft", "hips", 2.0, 0.5, True),
    LandmarkDefinition("left-rear-knee", "body", "rear-knee", "soft", "rear-knees", 2.0, 0.5, True),
    LandmarkDefinition("left-rear-paw", "body", "rear-paw", "hard", "rear-paws", 2.0, 0.5, True),
    LandmarkDefinition("right-hip", "body", "hip", "soft", "hips", 2.0, 0.5, True),
    LandmarkDefinition("right-rear-knee", "body", "rear-knee", "soft", "rear-knees", 2.0, 0.5, True),
    LandmarkDefinition("right-rear-paw", "body", "rear-paw", "hard", "rear-paws", 2.0, 0.5, True),
)


def observation_state(confidence: float) -> str:
    if confidence >= 0.6:
        return "observed"
    if confidence >= 0.2:
        return "inferred"
    return "missing"


def landmarks_from_ap10k(
    instance_id: str,
    keypoints: np.ndarray,
    scores: np.ndarray,
) -> list[dict]:
    if keypoints.shape != (1, 17, 2) or scores.shape != (1, 17):
        raise ValueError("AP-10K output must contain one 17-keypoint instance")
    provenance = [{
        "origin": "model",
        "provider": PROVIDER_ID,
        "model": MODEL_IDENTITY["modelId"],
        "version": MODEL_IDENTITY["weightRevision"],
    }]
    landmarks: list[dict] = []
    for index, definition in enumerate(AP10K_LANDMARKS):
        confidence = float(np.clip(scores[0, index], 0.0, 1.0))
        state = observation_state(confidence)
        landmark = {
            "id": f"{instance_id}:{definition.name}",
            "kind": definition.kind,
            "x": float(keypoints[0, index, 0]),
            "y": float(keypoints[0, index, 1]),
            "confidence": confidence,
            "priority": definition.priority,
            "sourceRadiusPx": definition.source_radius,
            "gridRadiusCells": definition.grid_radius,
            "carrierRegionId": f"{instance_id}:subject",
            "affectsOccupancy": definition.affects_occupancy and state == "observed",
            "structuralRole": definition.structural_role,
            "observationState": state,
            "provenance": provenance,
        }
        if definition.symmetry_group is not None:
            landmark["symmetryGroup"] = f"{instance_id}:{definition.symmetry_group}"
        if definition.feature_region is not None:
            landmark["featureRegionId"] = f"{instance_id}:{definition.feature_region}"
        landmarks.append(landmark)
    return landmarks


def pose_confidence(scores: np.ndarray) -> float:
    if scores.ndim != 2 or scores.shape[0] < 1 or scores.shape[1] != 17:
        raise ValueError("AP-10K scores must contain 17 keypoints per instance")
    identity_indices = np.array([0, 1, 2, 3, 4, 7, 10, 13, 16], dtype=np.int64)
    selected = np.clip(scores[:, identity_indices], 0.0, 1.0)
    return float(np.mean(selected))
