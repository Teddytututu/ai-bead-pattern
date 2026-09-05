from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

SCHEMA_VERSION = "ai-gateway-provider-v1"
PROVIDER_ID = "mmpose-animal-local"
UPSTREAM_SOURCE_REVISION = "5408bc76f5b848cf925a0d1857899011d8c5b497"
AP10K_SOURCE_REVISION = "181b1a04755e4dc6fe5616ef7a88496f47bfe228"
WEIGHT_URL = (
    "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/"
    "rtmpose-m_simcc-ap10k_pt-aic-coco_210e-256x256-7a041aa1_20230206.zip"
)
WEIGHT_ARCHIVE_SHA256 = "2d75445331cf2f21d6e164430f96ffa765cd874872965ae1736932dda03987f0"
WEIGHT_ONNX_SHA256 = "1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28"
WEIGHT_REVISION = f"sha256:{WEIGHT_ONNX_SHA256}"
MODEL_IDENTITY = {
    "modelId": "open-mmlab/rtmpose-m-ap10k-onnx",
    "modelVersion": "mmpose-v1.3.2+onnx-sdk-20230831",
    "sourceRevision": UPSTREAM_SOURCE_REVISION,
    "weightRevision": WEIGHT_REVISION,
}
MODEL_DESCRIPTOR = {
    **MODEL_IDENTITY,
    "architecture": "RTMPose-M SimCC AP-10K",
    "runtime": "onnxruntime-1.23.2",
    "weightSource": WEIGHT_URL,
    "datasetSourceRevision": AP10K_SOURCE_REVISION,
    "runtimeReference": {
        "repository": "https://github.com/Tau-J/rtmlib",
        "sourceRevision": "03a1693e59e4f7cd84582c0fb30459b3bf18ad42",
        "version": "0.0.16",
    },
    "license": {
        "spdx": "Apache-2.0",
        "url": (
            "https://github.com/open-mmlab/mmpose/blob/"
            f"{UPSTREAM_SOURCE_REVISION}/LICENSE"
        ),
    },
    "input": {
        "preferredWidth": 256,
        "preferredHeight": 256,
        "colorSpace": "srgb",
        "bboxPadding": 1.25,
        "simccSplitRatio": 2.0,
    },
    "keypoints": [
        "left-eye",
        "right-eye",
        "nose",
        "neck",
        "tail-root",
        "left-shoulder",
        "left-front-knee",
        "left-front-paw",
        "right-shoulder",
        "right-front-knee",
        "right-front-paw",
        "left-hip",
        "left-rear-knee",
        "left-rear-paw",
        "right-hip",
        "right-rear-knee",
        "right-rear-paw",
    ],
}

SUPPORTED_CAPABILITIES = frozenset({"keypoints"})
SUPPORTED_IMAGE_TYPES = frozenset({"pet", "general", "illustration"})
PET_INSTANCE_PATTERN = re.compile(r"^pet-[0-9]{2}$")

NormalizedBox = tuple[float, float, float, float]


def _record(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _bounded_text(
    value: Any,
    label: str,
    maximum: int,
    required: bool = False,
) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must contain bounded text")
    return value.strip()


def _unit(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    parsed = float(value)
    if parsed < 0.0 or parsed > 1.0:
        raise ValueError(f"{label} must stay within normalized bounds")
    return parsed


def _normalized_box(value: Any) -> NormalizedBox:
    box = _record(value, "instance prompt box")
    x = _unit(box.get("x"), "instance prompt box.x")
    y = _unit(box.get("y"), "instance prompt box.y")
    width = _unit(box.get("width"), "instance prompt box.width")
    height = _unit(box.get("height"), "instance prompt box.height")
    if width <= 0.0 or height <= 0.0 or x + width > 1.0 or y + height > 1.0:
        raise ValueError("instance prompt box must stay within normalized bounds")
    return (x, y, width, height)


def _box_from_lasso(value: Any) -> NormalizedBox | None:
    if value is None:
        return None
    if not isinstance(value, list) or not 3 <= len(value) <= 64:
        raise ValueError("instance prompt lasso must contain 3..64 points")
    points: list[tuple[float, float]] = []
    for index, entry in enumerate(value):
        point = _record(entry, f"instance prompt lasso[{index}]")
        points.append((
            _unit(point.get("x"), f"instance prompt lasso[{index}].x"),
            _unit(point.get("y"), f"instance prompt lasso[{index}].y"),
        ))
    left = min(point[0] for point in points)
    top = min(point[1] for point in points)
    right = max(point[0] for point in points)
    bottom = max(point[1] for point in points)
    if right - left < 0.01 or bottom - top < 0.01:
        raise ValueError("instance prompt lasso must enclose an area")
    padding = 0.02
    x = max(0.0, left - padding)
    y = max(0.0, top - padding)
    right = min(1.0, right + padding)
    bottom = min(1.0, bottom + padding)
    return (x, y, right - x, bottom - y)


@dataclass(frozen=True)
class PoseInstance:
    instance_id: str
    box: NormalizedBox
    label: str | None = None


def _instance_from_prompt(value: Any, default_id: str) -> PoseInstance:
    prompt = _record(value, "instance prompt")
    if prompt.get("box") is not None:
        box = _normalized_box(prompt["box"])
    else:
        box = _box_from_lasso(prompt.get("lasso")) or (0.0, 0.0, 1.0, 1.0)
    instance_id = _bounded_text(
        prompt.get("selectedInstanceId"),
        "selected instance id",
        32,
    ) or default_id
    if PET_INSTANCE_PATTERN.fullmatch(instance_id) is None:
        raise ValueError("selected pet instance id must use pet-XX")
    labels = prompt.get("labels")
    label: str | None = None
    if labels is not None:
        if not isinstance(labels, list) or not 1 <= len(labels) <= 16:
            raise ValueError("instance prompt labels must contain 1..16 entries")
        parsed = [
            _bounded_text(entry, f"instance prompt labels[{index}]", 128, True)
            for index, entry in enumerate(labels)
        ]
        if len(set(parsed)) != len(parsed):
            raise ValueError("instance prompt labels must be unique")
        label = parsed[0]
    return PoseInstance(instance_id=instance_id, box=box, label=label)


@dataclass(frozen=True)
class PoseRequest:
    instances: tuple[PoseInstance, ...]
    source_id: str | None = None
    capabilities: tuple[str, ...] = ("keypoints",)
    image_type_hint: str | None = "pet"

    @property
    def instance_id(self) -> str:
        return self.instances[0].instance_id

    @property
    def box(self) -> NormalizedBox:
        return self.instances[0].box

    @classmethod
    def from_wire(cls, value: Any) -> "PoseRequest":
        body = _record(value, "request")
        if body.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("request schema version is unsupported")
        model = dict(_record(body.get("model"), "model identity"))
        if model != MODEL_IDENTITY:
            raise ValueError("model identity differs from the pinned manifest")
        capabilities_value = body.get("capabilities")
        if (
            not isinstance(capabilities_value, list)
            or capabilities_value != ["keypoints"]
            or any(capability not in SUPPORTED_CAPABILITIES for capability in capabilities_value)
        ):
            raise ValueError("request capabilities must select keypoints")
        image_type_hint = body.get("imageTypeHint")
        if image_type_hint is not None and image_type_hint not in SUPPORTED_IMAGE_TYPES:
            raise ValueError("image type hint is unsupported")
        raw_prompt = body.get("instancePrompt")
        raw_prompts = body.get("instancePrompts")
        if raw_prompt is not None and raw_prompts is not None:
            raise ValueError("request must select singular or batched instance prompts")
        if raw_prompts is not None:
            if not isinstance(raw_prompts, list) or not 1 <= len(raw_prompts) <= 64:
                raise ValueError("instance prompts must contain 1..64 entries")
            instances = tuple(
                _instance_from_prompt(entry, f"pet-{index + 1:02d}")
                for index, entry in enumerate(raw_prompts)
            )
        elif raw_prompt is not None:
            instances = (_instance_from_prompt(raw_prompt, "pet-01"),)
        else:
            instances = (PoseInstance("pet-01", (0.0, 0.0, 1.0, 1.0)),)
        instance_ids = [instance.instance_id for instance in instances]
        if len(set(instance_ids)) != len(instance_ids):
            raise ValueError("pet instance ids must be unique")
        return cls(
            instances=instances,
            source_id=_bounded_text(body.get("sourceId"), "source id", 256),
            capabilities=tuple(capabilities_value),
            image_type_hint=image_type_hint,
        )
