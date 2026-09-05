from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

SCHEMA_VERSION = "ai-gateway-provider-v1"
PROVIDER_ID = "sam2-local"
GROUNDED_PROVIDER_ID = "grounded-sam2-local"
MODEL_REPOSITORY = "facebook/sam2.1-hiera-small"
MODEL_REVISION = "ee5bba1d82bb8749febdf90f45e84b687142ba03"
UPSTREAM_SAM2_SOURCE_REVISION = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
GROUNDING_DINO_MODEL_REPOSITORY = "IDEA-Research/grounding-dino-tiny"
GROUNDING_DINO_MODEL_REVISION = "a2bb814dd30d776dcf7e30523b00659f4f141c71"
UPSTREAM_GROUNDING_DINO_SOURCE_REVISION = "856dde20aee659246248e20734ef9ba5214f5e44"
UPSTREAM_GROUNDED_SAM2_SOURCE_REVISION = "dd4c5141b75e4838dd486c64f773c43b4db3a07b"
TRANSFORMERS_VERSION = "5.16.1"
TRANSFORMERS_SOURCE_REVISION = "93c8b7b485963a10800c91f55304db6be211c2bd"
DEFAULT_DETECTION_LABELS = ("a cat", "a dog", "a rabbit", "a pet")
DEFAULT_DETECTION_TEXT = "a cat. a dog. a rabbit. a pet."
MODEL_IDENTITY = {
    "modelId": MODEL_REPOSITORY,
    "modelVersion": f"transformers-{TRANSFORMERS_VERSION}+sam2.1",
    "sourceRevision": TRANSFORMERS_SOURCE_REVISION,
    "weightRevision": f"hf:{MODEL_REVISION}",
}
GROUNDED_MODEL_IDENTITY = {
    "modelId": (
        f"{GROUNDING_DINO_MODEL_REPOSITORY}+{MODEL_REPOSITORY}"
    ),
    "modelVersion": f"transformers-{TRANSFORMERS_VERSION}+grounded-sam2-1.0",
    "sourceRevision": UPSTREAM_GROUNDED_SAM2_SOURCE_REVISION,
    "weightRevision": (
        f"hf:{GROUNDING_DINO_MODEL_REVISION}+hf:{MODEL_REVISION}"
    ),
}
MODEL_DESCRIPTOR = {
    **MODEL_IDENTITY,
    "architecture": "SAM 2.1 Hiera Small",
    "runtime": "transformers.Sam2Model",
    "runtimeSourceRevision": TRANSFORMERS_SOURCE_REVISION,
    "upstreamSourceRevision": UPSTREAM_SAM2_SOURCE_REVISION,
    "weightSource": f"https://huggingface.co/{MODEL_REPOSITORY}/tree/{MODEL_REVISION}",
    "license": {
        "spdx": "Apache-2.0",
        "url": (
            "https://github.com/facebookresearch/sam2/blob/"
            f"{UPSTREAM_SAM2_SOURCE_REVISION}/LICENSE"
        ),
    },
    "weightLicense": {
        "spdx": "Apache-2.0",
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/blob/{MODEL_REVISION}/README.md",
    },
    "input": {
        "preferredWidth": 1024,
        "preferredHeight": 1024,
        "colorSpace": "srgb",
    },
}
GROUNDED_MODEL_DESCRIPTOR = {
    **GROUNDED_MODEL_IDENTITY,
    "architecture": "Grounding DINO Tiny + SAM 2.1 Hiera Small",
    "runtime": "transformers.GroundingDinoForObjectDetection+Sam2Model",
    "runtimeSourceRevision": TRANSFORMERS_SOURCE_REVISION,
    "upstreamGroundingDinoSourceRevision": UPSTREAM_GROUNDING_DINO_SOURCE_REVISION,
    "upstreamGroundedSam2SourceRevision": UPSTREAM_GROUNDED_SAM2_SOURCE_REVISION,
    "weightSource": (
        f"https://huggingface.co/{GROUNDING_DINO_MODEL_REPOSITORY}/tree/"
        f"{GROUNDING_DINO_MODEL_REVISION}"
    ),
    "license": {
        "spdx": "Apache-2.0",
        "url": (
            "https://github.com/IDEA-Research/Grounded-SAM-2/blob/"
            f"{UPSTREAM_GROUNDED_SAM2_SOURCE_REVISION}/LICENSE"
        ),
    },
    "weightLicense": {
        "spdx": "Apache-2.0",
        "url": (
            f"https://huggingface.co/{GROUNDING_DINO_MODEL_REPOSITORY}/blob/"
            f"{GROUNDING_DINO_MODEL_REVISION}/README.md"
        ),
    },
    "input": {
        "preferredWidth": 1024,
        "preferredHeight": 1024,
        "colorSpace": "srgb",
    },
    "defaultDetectionText": DEFAULT_DETECTION_TEXT,
    "components": [
        {
            "modelId": GROUNDING_DINO_MODEL_REPOSITORY,
            "sourceRevision": UPSTREAM_GROUNDING_DINO_SOURCE_REVISION,
            "weightRevision": f"hf:{GROUNDING_DINO_MODEL_REVISION}",
            "license": "Apache-2.0",
        },
        {
            "modelId": MODEL_REPOSITORY,
            "sourceRevision": UPSTREAM_SAM2_SOURCE_REVISION,
            "weightRevision": f"hf:{MODEL_REVISION}",
            "license": "Apache-2.0",
        },
    ],
}
SUPPORTED_CAPABILITIES = frozenset({
    "subject-segmentation",
    "edge-thin-structure",
})
IMAGE_TYPES = frozenset({"portrait", "pet", "illustration", "landscape", "general"})

Point = tuple[float, float]
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


def _point(value: Any, label: str) -> Point:
    entry = _record(value, label)
    return (_unit(entry.get("x"), f"{label}.x"), _unit(entry.get("y"), f"{label}.y"))


def _points(
    value: Any,
    label: str,
    minimum: int,
    maximum: int = 64,
) -> tuple[Point, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) < minimum or len(value) > maximum:
        raise ValueError(f"{label} must contain {minimum}..{maximum} points")
    return tuple(_point(entry, f"{label}[{index}]") for index, entry in enumerate(value))


def _polygon_area(points: tuple[Point, ...]) -> float:
    area = 0.0
    for index, current in enumerate(points):
        following = points[(index + 1) % len(points)]
        area += current[0] * following[1] - following[0] * current[1]
    return abs(area) * 0.5


@dataclass(frozen=True)
class InstancePrompt:
    lasso: tuple[Point, ...] = ()
    box: NormalizedBox | None = None
    positive_points: tuple[Point, ...] = ()
    negative_points: tuple[Point, ...] = ()
    labels: tuple[str, ...] = ()
    selected_instance_id: str | None = None

    @classmethod
    def from_wire(
        cls,
        value: Any,
        *,
        allow_labels_only: bool = False,
    ) -> "InstancePrompt":
        body = _record(value, "instance prompt")
        lasso = _points(body.get("lasso"), "instance prompt lasso", 3)
        if lasso and _polygon_area(lasso) < 0.0001:
            raise ValueError("instance prompt lasso must enclose an area")
        positive_points = _points(
            body.get("positivePoints"),
            "instance prompt positive points",
            1,
        )
        negative_points = _points(
            body.get("negativePoints"),
            "instance prompt negative points",
            1,
        )
        box = None
        if body.get("box") is not None:
            raw_box = _record(body["box"], "instance prompt box")
            x = _unit(raw_box.get("x"), "instance prompt box.x")
            y = _unit(raw_box.get("y"), "instance prompt box.y")
            width = _unit(raw_box.get("width"), "instance prompt box.width")
            height = _unit(raw_box.get("height"), "instance prompt box.height")
            if width <= 0.0 or height <= 0.0 or x + width > 1.0 or y + height > 1.0:
                raise ValueError("instance prompt box must stay within normalized bounds")
            box = (x, y, width, height)
        labels_value = body.get("labels")
        labels: tuple[str, ...] = ()
        if labels_value is not None:
            if not isinstance(labels_value, list) or not 1 <= len(labels_value) <= 16:
                raise ValueError("instance prompt labels must contain 1..16 entries")
            parsed_labels = tuple(
                _bounded_text(entry, f"instance prompt labels[{index}]", 128, True)
                for index, entry in enumerate(labels_value)
            )
            labels = tuple(label for label in parsed_labels if label is not None)
            if len(set(labels)) != len(labels):
                raise ValueError("instance prompt labels must be unique")
        selected_instance_id = _bounded_text(
            body.get("selectedInstanceId"),
            "selected instance id",
            256,
        )
        if not lasso and box is None and not positive_points and not (allow_labels_only and labels):
            raise ValueError("instance prompt requires positive guidance")
        return cls(
            lasso=lasso,
            box=box,
            positive_points=positive_points,
            negative_points=negative_points,
            labels=labels,
            selected_instance_id=selected_instance_id,
        )


@dataclass(frozen=True)
class SegmentationRequest:
    capabilities: tuple[str, ...]
    image_type_hint: str | None
    prompt: InstancePrompt
    source_id: str | None = None
    automatic_detection: bool = False

    @classmethod
    def from_wire(cls, value: Any) -> "SegmentationRequest":
        body = _record(value, "request")
        if body.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("request schema version is unsupported")
        model = _record(body.get("model"), "model identity")
        model_identity = dict(model)
        if model_identity == MODEL_IDENTITY:
            automatic_detection = False
        elif model_identity == GROUNDED_MODEL_IDENTITY:
            automatic_detection = True
        else:
            raise ValueError("model identity differs from the pinned manifest")
        capabilities_value = body.get("capabilities")
        if (
            not isinstance(capabilities_value, list)
            or len(capabilities_value) == 0
            or len(capabilities_value) > len(SUPPORTED_CAPABILITIES)
            or any(not isinstance(capability, str) for capability in capabilities_value)
            or len(set(capabilities_value)) != len(capabilities_value)
            or any(capability not in SUPPORTED_CAPABILITIES for capability in capabilities_value)
        ):
            raise ValueError("request capabilities must select supported segmentation features")
        image_type_hint = body.get("imageTypeHint")
        if image_type_hint is not None and image_type_hint not in IMAGE_TYPES:
            raise ValueError("image type hint is unsupported")
        raw_prompt = body.get("instancePrompt")
        if automatic_detection:
            if raw_prompt is None:
                detection_text = _bounded_text(body.get("prompt"), "detection text", 1024)
                if detection_text is None:
                    labels = DEFAULT_DETECTION_LABELS
                else:
                    labels = tuple(
                        label.strip()
                        for label in detection_text.split(".")
                        if label.strip()
                    )
                    if not 1 <= len(labels) <= 16 or len(set(labels)) != len(labels):
                        raise ValueError("detection text must contain 1..16 unique labels")
                prompt = InstancePrompt(labels=labels)
            else:
                prompt = InstancePrompt.from_wire(raw_prompt, allow_labels_only=True)
                if not prompt.labels:
                    prompt = InstancePrompt(
                        lasso=prompt.lasso,
                        box=prompt.box,
                        positive_points=prompt.positive_points,
                        negative_points=prompt.negative_points,
                        labels=DEFAULT_DETECTION_LABELS,
                        selected_instance_id=prompt.selected_instance_id,
                    )
        else:
            prompt = InstancePrompt.from_wire(raw_prompt)
        return cls(
            capabilities=tuple(capabilities_value),
            image_type_hint=image_type_hint,
            prompt=prompt,
            source_id=_bounded_text(body.get("sourceId"), "source id", 256),
            automatic_detection=automatic_detection,
        )
