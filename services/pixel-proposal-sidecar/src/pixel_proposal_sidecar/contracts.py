from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from math import isfinite
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


def _positive_integer(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _finite_number(value: Any, label: str) -> float:
    if (not isinstance(value, (int, float)) or isinstance(value, bool)
            or not isfinite(value)):
        raise ValueError(f"{label} must be finite")
    return float(value)


@dataclass(frozen=True)
class ProposalSourceFrame:
    fit: Literal["contain"]
    source_width: int
    source_height: int
    x: float
    y: float
    width: float
    height: float

    def to_wire(self) -> dict[str, Any]:
        return {
            "fit": self.fit,
            "sourceWidth": self.source_width,
            "sourceHeight": self.source_height,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }

    def scaled(self, from_size: tuple[int, int], to_size: tuple[int, int]) -> "ProposalSourceFrame":
        from_width, from_height = from_size
        to_width, to_height = to_size
        scale_x = to_width / from_width
        scale_y = to_height / from_height
        return ProposalSourceFrame(
            fit="contain",
            source_width=self.source_width,
            source_height=self.source_height,
            x=self.x * scale_x,
            y=self.y * scale_y,
            width=self.width * scale_x,
            height=self.height * scale_y,
        )

    @classmethod
    def from_wire(
        cls,
        value: Any,
        *,
        proposal_size: tuple[int, int],
        source_size: tuple[int, int] | None = None,
    ) -> "ProposalSourceFrame":
        body = _record(value, "proposal source frame")
        if body.get("fit") != "contain":
            raise ValueError("proposal source frame fit must use contain")
        source_width = _positive_integer(body.get("sourceWidth"), "source width")
        source_height = _positive_integer(body.get("sourceHeight"), "source height")
        if source_size is not None and (source_width, source_height) != source_size:
            raise ValueError("proposal source dimensions differ from the uploaded image")
        proposal_width = _positive_integer(proposal_size[0], "proposal width")
        proposal_height = _positive_integer(proposal_size[1], "proposal height")
        frame = cls(
            fit="contain",
            source_width=source_width,
            source_height=source_height,
            x=_finite_number(body.get("x"), "source frame x"),
            y=_finite_number(body.get("y"), "source frame y"),
            width=_finite_number(body.get("width"), "source frame width"),
            height=_finite_number(body.get("height"), "source frame height"),
        )
        if frame.x < 0 or frame.y < 0 or frame.width <= 0 or frame.height <= 0:
            raise ValueError("proposal source frame must have positive in-bounds geometry")
        if (frame.x + frame.width > proposal_width + 1e-6
                or frame.y + frame.height > proposal_height + 1e-6):
            raise ValueError("proposal source frame must stay inside the proposal image")
        expected = contain_source_frame(
            (source_width, source_height),
            (proposal_width, proposal_height),
        )
        tolerance = max(0.01, max(proposal_width, proposal_height) / 512)
        if any(abs(actual - target) > tolerance for actual, target in (
            (frame.x, expected.x),
            (frame.y, expected.y),
            (frame.width, expected.width),
            (frame.height, expected.height),
        )):
            raise ValueError("proposal source frame must describe a centered contain mapping")
        return frame


def contain_source_frame(
    source_size: tuple[int, int],
    proposal_size: tuple[int, int],
) -> ProposalSourceFrame:
    source_width = _positive_integer(source_size[0], "source width")
    source_height = _positive_integer(source_size[1], "source height")
    proposal_width = _positive_integer(proposal_size[0], "proposal width")
    proposal_height = _positive_integer(proposal_size[1], "proposal height")
    scale = min(proposal_width / source_width, proposal_height / source_height)
    width = source_width * scale
    height = source_height * scale
    return ProposalSourceFrame(
        fit="contain",
        source_width=source_width,
        source_height=source_height,
        x=(proposal_width - width) / 2,
        y=(proposal_height - height) / 2,
        width=width,
        height=height,
    )


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
