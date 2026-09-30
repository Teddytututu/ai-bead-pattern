from __future__ import annotations

import base64
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

SmallText = Annotated[str, Field(min_length=1, max_length=200)]
Channel = Annotated[int, Field(ge=0, le=255)]


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Color(Wire):
    id: SmallText
    rgb: Annotated[list[Channel], Field(min_length=3, max_length=3)]


class Grid(Wire):
    width: Annotated[int, Field(ge=1, le=64)]
    height: Annotated[int, Field(ge=1, le=64)]
    paletteId: SmallText
    paletteVersion: SmallText
    colors: Annotated[list[Color], Field(min_length=1, max_length=291)]
    cells: Annotated[list[int], Field(min_length=1, max_length=4096)]

    @model_validator(mode="after")
    def dimensions(self):
        if len(self.cells) != self.width * self.height:
            raise ValueError("cells must cover the full grid")
        if len({c.id for c in self.colors}) != len(self.colors):
            raise ValueError("material ids must be unique")
        if any(c < -1 or c >= len(self.colors) for c in self.cells):
            raise ValueError("cells must use material indices or -1 for empty board")
        return self


class SourceImage(Wire):
    width: Annotated[int, Field(ge=1, le=2048)]
    height: Annotated[int, Field(ge=1, le=2048)]
    rgbaBase64: Annotated[str, Field(min_length=4, max_length=24_000_000)]
    mapping: Literal["contain-full-image"]

    @model_validator(mode="after")
    def valid_bytes(self):
        try:
            raw = base64.b64decode(self.rgbaBase64, validate=True)
        except ValueError as error:
            raise ValueError("invalid source RGBA base64") from error
        if len(raw) != self.width * self.height * 4:
            raise ValueError("source RGBA size differs from dimensions")
        return self


class RegionRequest(Wire):
    schemaVersion: Literal["region-generation-v3"]
    currentGrid: Grid
    editMask: Annotated[list[bool], Field(min_length=1, max_length=4096)]
    lockedMask: Annotated[list[bool], Field(min_length=1, max_length=4096)]
    inputMode: Literal["grid-context"] = "grid-context"
    contextSha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] | None = None
    task: Literal["detail-repair", "harmonize"] = "detail-repair"
    fillPolicy: Literal["all-editable"] = "all-editable"
    maxAttempts: Annotated[int, Field(ge=1, le=3)] = 3
    harmonyStrength: Annotated[float, Field(ge=0, le=1)] = 0.35
    skinColorId: SmallText | None = None
    prompt: Annotated[str, Field(min_length=1, max_length=1500)]
    negativePrompt: Annotated[str, Field(max_length=1500)] = "text, watermark, blurry, gradients, noisy texture, unfilled hole, blank patch"
    workingSize: Literal[512, 768, 1024] = 512
    steps: Annotated[int, Field(ge=2, le=50)] = 20
    strength: Annotated[float, Field(ge=0.1, le=0.99)] = 0.99
    guidanceScale: Annotated[float, Field(ge=1, le=12)] = 8.0
    seed: Annotated[int, Field(ge=0, le=2**32 - 1)] = 42
    maximumColors: Annotated[int, Field(ge=1, le=48)] = 24
    adapter: Literal["none", "configured"] = "none"

    @model_validator(mode="after")
    def consistent(self):
        n = len(self.currentGrid.cells)
        if len(self.editMask) != n or len(self.lockedMask) != n:
            raise ValueError("both masks must cover the full grid")
        if not any(e and not l for e, l in zip(self.editMask, self.lockedMask)):
            raise ValueError("no editable cells remain after locks")
        if int(self.steps * self.strength) < 1:
            raise ValueError("steps times strength must produce at least one denoising step")
        if any(e and l and c == -1 for e, l, c in zip(self.editMask, self.lockedMask, self.currentGrid.cells)):
            raise ValueError("an empty cell inside the edit region is locked; unlock it before filling")
        if not any(c >= 0 and (not e or l) for c, e, l in zip(self.currentGrid.cells, self.editMask, self.lockedMask)):
            raise ValueError("keep some occupied full-grid context outside the effective hole")
        used = {c for c in self.currentGrid.cells if c >= 0}
        if self.skinColorId is not None and self.skinColorId not in {c.id for c in self.currentGrid.colors}:
            raise ValueError("skinColorId must be a material in the current palette")
        if len(used) > self.maximumColors:
            raise ValueError("current grid already exceeds the color budget")
        return self
