from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Literal, Mapping

SCHEMA_VERSION = "ai-gateway-provider-v1"
PROVIDER_ID = "pixel-art-sprite-lcm-local"
MODEL_IDENTITY = {
    "modelId": "Onodofthenorth/SD_PixelArt_SpriteSheet_Generator+latent-consistency/lcm-lora-sdv1-5",
    "modelVersion": "diffusers-0.35.2",
    "sourceRevision": "b71269675ec1b85193107a691dd35c308e46f0a5",
    "weightRevision": (
        "hf:pixel-art-sprite@8229c9b6e928103f0e657cfe6b14d902cb2101d6"
        "+lcm-lora-sdv1-5@cf2fced511dbe7e26c8d1d397e728fbab875db4b"
    ),
}
SUPPORTED_CAPABILITIES = frozenset({
    "learned-pixelization",
    "generative-proposal",
})

ProposalKind = Literal["learned-pixelization", "generative-proposal"]


def _record(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _optional_text(value: Any, label: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must contain bounded text")
    return value.strip()


@dataclass(frozen=True)
class ProposalRequest:
    kind: ProposalKind
    target_grid: tuple[int, int]
    palette_id: str | None = None
    style_id: str | None = None
    prompt: str | None = None
    source_id: str | None = None

    @classmethod
    def from_wire(cls, value: Any) -> "ProposalRequest":
        body = _record(value, "request")
        if body.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("request schema version is unsupported")
        model = _record(body.get("model"), "model identity")
        if dict(model) != MODEL_IDENTITY:
            raise ValueError("model identity differs from the pinned manifest")
        capabilities = body.get("capabilities")
        if (not isinstance(capabilities, list) or len(capabilities) != 1
                or capabilities[0] not in SUPPORTED_CAPABILITIES):
            raise ValueError("request must select one supported proposal capability")
        grid = _record(body.get("targetGrid", {"width": 48, "height": 48}), "target grid")
        width = grid.get("width")
        height = grid.get("height")
        if (not isinstance(width, int) or isinstance(width, bool)
                or not isinstance(height, int) or isinstance(height, bool)
                or width < 8 or height < 8 or width > 256 or height > 256):
            raise ValueError("target grid must stay within 8..256 cells")
        return cls(
            kind=capabilities[0],
            target_grid=(width, height),
            palette_id=_optional_text(body.get("paletteId"), "palette id", 128),
            style_id=_optional_text(body.get("styleId"), "style id", 128),
            prompt=_optional_text(body.get("prompt"), "prompt", 1000),
            source_id=_optional_text(body.get("sourceId"), "source id", 256),
        )


def deterministic_seeds(source: bytes, kind: ProposalKind, count: int) -> list[int]:
    if count < 1 or count > 8:
        raise ValueError("seed count must stay within 1..8")
    seeds: list[int] = []
    for index in range(count):
        digest = sha256(source + kind.encode("ascii") + index.to_bytes(2, "big")).digest()
        seeds.append(int.from_bytes(digest[:4], "big") & 0x7FFFFFFF)
    return seeds
