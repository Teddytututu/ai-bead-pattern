from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

SCHEMA_VERSION = "ai-gateway-provider-v1"
PROVIDER_ID = "dinov2-vits14-pair-local"
MODEL_REPOSITORY = "facebook/dinov2-small"
MODEL_NAME = "ViT-S/14"
MODEL_VERSION = "transformers-5.16.1+dinov2-vits14"
SOURCE_REVISION = "7764ea0f912e53c92e82eb78a2a1631e92725fc8"
WEIGHT_REVISION = "ed25f3a31f01632728cabb09d1542f84ab7b0056"
EMBEDDING_DIMENSIONS = 384
INPUT_SIZE = 224
PATCH_SIZE = 14
MODEL_IDENTITY = {
    "modelId": MODEL_REPOSITORY,
    "modelVersion": MODEL_VERSION,
    "sourceRevision": SOURCE_REVISION,
    "weightRevision": f"hf:{WEIGHT_REVISION}",
}
MODEL_DESCRIPTOR = {
    **MODEL_IDENTITY,
    "architecture": MODEL_NAME,
    "weightSource": (
        f"https://huggingface.co/{MODEL_REPOSITORY}/tree/{WEIGHT_REVISION}"
    ),
    "license": {
        "spdx": "Apache-2.0",
        "url": (
            "https://github.com/facebookresearch/dinov2/blob/"
            f"{SOURCE_REVISION}/LICENSE"
        ),
    },
    "weightLicense": {
        "spdx": "Apache-2.0",
        "url": (
            f"https://huggingface.co/{MODEL_REPOSITORY}/blob/"
            f"{WEIGHT_REVISION}/README.md"
        ),
    },
    "input": {
        "width": INPUT_SIZE,
        "height": INPUT_SIZE,
        "patchSize": PATCH_SIZE,
        "colorSpace": "srgb",
        "resizeMode": "contain-white-pad-patch",
    },
    "defaultPrecision": "fp32",
    "embeddingDimensions": EMBEDDING_DIMENSIONS,
}
SUPPORTED_CAPABILITIES = frozenset({"embedding", "preference-scoring"})


def _record(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _bounded_text(value: Any, label: str, maximum: int, required: bool) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must contain bounded text")
    return value.strip()


@dataclass(frozen=True)
class PairRequest:
    capabilities: tuple[str, ...]
    candidate_id: str
    source_id: str | None = None

    @classmethod
    def from_wire(cls, value: Any) -> "PairRequest":
        body = _record(value, "request")
        if body.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("request schema version is unsupported")
        model = _record(body.get("model"), "model identity")
        if dict(model) != MODEL_IDENTITY:
            raise ValueError("model identity differs from the pinned manifest")
        capabilities = body.get("capabilities")
        if (
            not isinstance(capabilities, list)
            or len(capabilities) == 0
            or len(capabilities) > len(SUPPORTED_CAPABILITIES)
            or any(not isinstance(capability, str) for capability in capabilities)
            or len(set(capabilities)) != len(capabilities)
            or any(capability not in SUPPORTED_CAPABILITIES for capability in capabilities)
        ):
            raise ValueError("request capabilities must select supported pair features")
        if "preference-scoring" not in capabilities:
            raise ValueError("request capabilities must include preference-scoring")
        candidate_id = _bounded_text(body.get("candidateId"), "candidate id", 256, True)
        source_id = _bounded_text(body.get("sourceId"), "source id", 256, False)
        assert candidate_id is not None
        return cls(
            capabilities=tuple(capabilities),
            candidate_id=candidate_id,
            source_id=source_id,
        )
