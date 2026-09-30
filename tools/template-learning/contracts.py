"""FT0 offline wire contract. Supervision never enters GenerationInput.

Coordinates are cell indices, x right / y down, row-major. Stored grids are
unpadded; only tensorize() adds bottom/right padding. This is not a product API.
"""
from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VERSION = 'template-learning-v1'
Unit = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Byte = Annotated[int, Field(ge=0, le=255)]
Dimension = Annotated[int, Field(ge=1, le=64)]
Index = Annotated[int, Field(ge=0, le=63)]
Text = Annotated[str, Field(min_length=1, max_length=512)]
Part = Literal['eye', 'nose', 'mouth']
Visibility = Literal['visible', 'occluded', 'not-drawn', 'not-detected', 'unknown']
Role = Literal['eye-dark', 'eye-highlight', 'eye-iris', 'eye-white',
               'nose-base', 'mouth-dark', 'mouth-inner', 'preserve-base']
ROLE_SETS = {
    'eye': {'eye-dark', 'eye-highlight', 'eye-iris', 'eye-white'},
    'nose': {'nose-base'}, 'mouth': {'mouth-dark', 'mouth-inner'},
}


class Wire(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Versions(Wire):
    preprocessing: Text
    segmentation: Text
    palette: Text


class Grid(Wire):
    width: Dimension
    height: Dimension
    rgb: list[list[Byte]]
    occupancy: list[Literal[0, 1] | None]

    @field_validator('occupancy', mode='before')
    @classmethod
    def occupancy_types(cls, value):
        if not isinstance(value, list) or any(v is not None and type(v) is not int for v in value):
            raise ValueError('occupancy uses integer 0/1/null, not boolean')
        return value

    @model_validator(mode='after')
    def dimensions(self) -> Self:
        n = self.width * self.height
        if len(self.rgb) != n or any(len(c) != 3 for c in self.rgb):
            raise ValueError('RGB must contain W*H triples; resizing is forbidden')
        if len(self.occupancy) != n:
            raise ValueError('occupancy must contain W*H values; null means unknown')
        if any(isinstance(v, bool) for v in self.occupancy):
            raise ValueError('occupancy uses 0/1/null, not boolean')
        return self


class Point(Wire):
    x: Index
    y: Index


class Box(Wire):
    x: Index
    y: Index
    width: Dimension
    height: Dimension


class Evidence(Wire):
    instanceId: Text
    parentId: Text | None
    kind: Literal['subject', 'face', 'eye', 'nose', 'mouth']
    box: Box
    mask: list[bool]
    confidence: Unit
    visibility: Visibility
    origin: Literal['predicted']


class Query(Wire):
    kind: Part
    subjectInstanceId: Text | None
    faceInstanceId: Text | None
    partInstanceId: Text | None
    position: Point
    side: Literal['image-left', 'image-right', 'unknown', 'not-applicable']


class Constraints(Wire):
    maximumOccupiedCells: Annotated[int, Field(ge=1, le=4096)]
    maximumColors: Annotated[int, Field(ge=1, le=48)]
    protectedGridMask: list[bool]
    lockedGridMask: list[bool]
    neighborGridMask: list[bool]
    minimumNeighborGap: Annotated[int, Field(ge=0, le=64)]
    maximumCandidates: Annotated[int, Field(ge=1, le=4)] = 4


class GenerationInput(Wire):
    schemaVersion: Literal['template-learning-v1'] = VERSION
    inputId: Text
    task: Literal['A-reconstruction', 'B-conversion']
    inputStage: Literal['decoded-pattern', 'before-template-application']
    patternGrid: Grid
    validGridMask: list[bool]
    segmentationEvidence: list[Evidence]
    partQuery: Query
    constraints: Constraints
    sourceVersions: Versions

    @model_validator(mode='after')
    def coherent(self) -> Self:
        grid, query = self.patternGrid, self.partQuery
        n = grid.width * grid.height
        expected = 'decoded-pattern' if self.task == 'A-reconstruction' else 'before-template-application'
        if self.inputStage != expected:
            raise ValueError('task/input stage mismatch; B cannot consume a corrected final pattern')
        if len(self.validGridMask) != n or not all(self.validGridMask):
            raise ValueError('wire input must retain every full-pattern cell; padding is tensor-only')
        if query.position.x >= grid.width or query.position.y >= grid.height:
            raise ValueError('query outside full grid')
        for name in ('protectedGridMask', 'lockedGridMask', 'neighborGridMask'):
            if len(getattr(self.constraints, name)) != n:
                raise ValueError(f'{name} must cover the full grid')
        ids = {e.instanceId: e for e in self.segmentationEvidence}
        if len(ids) != len(self.segmentationEvidence):
            raise ValueError('duplicate evidence instance ID')
        if any(e.parentId is not None and e.parentId not in ids for e in self.segmentationEvidence):
            raise ValueError('unresolved evidence parent')
        for e in self.segmentationEvidence:
            b = e.box
            if b.x + b.width > grid.width or b.y + b.height > grid.height:
                raise ValueError('evidence box outside full grid')
            if len(e.mask) != n:
                raise ValueError('evidence mask must cover the full grid')
            if any(v and not (b.x <= i % grid.width < b.x + b.width and
                             b.y <= i // grid.width < b.y + b.height)
                   for i, v in enumerate(e.mask)):
                raise ValueError('evidence mask extends outside its box')
            if e.parentId is not None and e.parentId not in ids:
                raise ValueError('unresolved evidence parent')
            seen = {e.instanceId}
            parent = e.parentId
            while parent is not None:
                if parent in seen:
                    raise ValueError('cyclic evidence parents')
                seen.add(parent)
                parent = ids[parent].parentId
        for reference, kind in ((query.subjectInstanceId, 'subject'),
                                (query.faceInstanceId, 'face'),
                                (query.partInstanceId, query.kind)):
            if reference is not None and (reference not in ids or ids[reference].kind != kind):
                raise ValueError('query reference missing or wrong kind')
        chain = [v for v in (query.partInstanceId, query.faceInstanceId, query.subjectInstanceId) if v]
        for child, ancestor in zip(chain, chain[1:]):
            parent = ids[child].parentId
            while parent is not None and parent != ancestor:
                parent = ids[parent].parentId
            if parent != ancestor:
                raise ValueError('query crosses subject/face instances')
        return self


class Candidate(Wire):
    candidateId: Text
    width: Dimension
    height: Dimension
    cells: list[Role]
    anchor: Point
    placementAnchor: Point
    confidence: Unit

    @model_validator(mode='after')
    def coherent(self) -> Self:
        if len(self.cells) != self.width * self.height:
            raise ValueError('cells must match predicted width and height exactly')
        if self.anchor.x >= self.width or self.anchor.y >= self.height:
            raise ValueError('local anchor outside predicted matrix')
        if all(role == 'preserve-base' for role in self.cells):
            raise ValueError('empty template must use no_template')
        return self


class GenerationOutput(Wire):
    schemaVersion: Literal['template-learning-v1'] = VERSION
    inputId: Text
    kind: Part
    status: Literal['candidates', 'no_template']
    candidates: Annotated[list[Candidate], Field(max_length=4)]
    reason: Text | None
    sourceVersions: Versions
    generatorVersion: Text

    @model_validator(mode='after')
    def coherent(self) -> Self:
        if self.status == 'no_template':
            if self.candidates or not self.reason:
                raise ValueError('no_template requires a reason and no matrices')
        elif not self.candidates:
            raise ValueError('candidate output cannot be empty')
        if len({c.candidateId for c in self.candidates}) != len(self.candidates):
            raise ValueError('duplicate candidate IDs')
        for c in self.candidates:
            if set(c.cells) - ROLE_SETS[self.kind] - {'preserve-base'}:
                raise ValueError('cell role does not match part kind')
        return self


class Review(Wire):
    reviewer: Text
    reviewedAt: Text
    annotationVersion: Text
    method: Literal['human']
    elapsedSeconds: Annotated[float, Field(ge=0)]


class Target(Wire):
    """Supervision is stored separately, with unknown cells excluded from loss."""
    schemaVersion: Literal['template-learning-v1'] = VERSION
    inputId: Text
    kind: Part
    visibility: Visibility
    status: Literal['template', 'no_template', 'unknown']
    width: Dimension | None
    height: Dimension | None
    cells: list[Role | Literal['unknown']]
    anchor: Point | None
    placementAnchor: Point | None
    acceptableSizes: list[list[Dimension]]
    review: Review

    @model_validator(mode='after')
    def coherent(self) -> Self:
        if self.status != 'template':
            if any(v is not None for v in (self.width, self.height, self.anchor, self.placementAnchor)) or self.cells or self.acceptableSizes:
                raise ValueError('non-template target cannot contain template dimensions or cells')
            if self.status == 'no_template' and self.visibility in ('unknown', 'not-detected'):
                raise ValueError('unknown or missed detection cannot become an absence label')
            return self
        if self.width is None or self.height is None or self.anchor is None or self.placementAnchor is None:
            raise ValueError('template target requires dimensions and both anchors')
        if len(self.cells) != self.width * self.height:
            raise ValueError('target matrix and dimensions disagree')
        if self.anchor.x >= self.width or self.anchor.y >= self.height:
            raise ValueError('target anchor outside matrix')
        if set(self.cells) - ROLE_SETS[self.kind] - {'preserve-base', 'unknown'}:
            raise ValueError('target role does not match part')
        if not any(role in ROLE_SETS[self.kind] for role in self.cells):
            raise ValueError('target needs known functional cells')
        if any(len(size) != 2 for size in self.acceptableSizes) or [self.width, self.height] not in self.acceptableSizes:
            raise ValueError('acceptable sizes must include the reviewed dimensions')
        return self


def validate_output(value: GenerationOutput, request: GenerationInput) -> None:
    if value.inputId != request.inputId or value.kind != request.partQuery.kind:
        raise ValueError('output does not belong to this query')
    if value.sourceVersions != request.sourceVersions:
        raise ValueError('source version mismatch')
    g, limits = request.patternGrid, request.constraints
    if len(value.candidates) > limits.maximumCandidates:
        raise ValueError('candidate budget exceeded')
    neighbors = [(i % g.width, i // g.width) for i, v in enumerate(limits.neighborGridMask) if v]
    for c in value.candidates:
        left, top = c.placementAnchor.x - c.anchor.x, c.placementAnchor.y - c.anchor.y
        if left < 0 or top < 0 or left + c.width > g.width or top + c.height > g.height:
            raise ValueError('predicted matrix outside canvas; do not clip or resize it')
        occupied = [(i % c.width + left, i // c.width + top) for i, role in enumerate(c.cells) if role != 'preserve-base']
        if len(occupied) > limits.maximumOccupiedCells:
            raise ValueError('occupied-cell budget exceeded')
        # Roles are not material colors. maximumColors is enforced by the FT5
        # palette resolver, not by falsely treating each role as a distinct SKU.
        for x, y in occupied:
            index = y * g.width + x
            if limits.protectedGridMask[index] or limits.lockedGridMask[index]:
                raise ValueError('candidate overwrites a protected or locked cell')
            if any(max(abs(x - nx), abs(y - ny)) <= limits.minimumNeighborGap for nx, ny in neighbors):
                raise ValueError('candidate violates neighbor separation')


def validate_target(value: Target, request: GenerationInput) -> None:
    if value.inputId != request.inputId or value.kind != request.partQuery.kind:
        raise ValueError('target does not belong to this query')
    if value.status == 'template':
        left = value.placementAnchor.x - value.anchor.x
        top = value.placementAnchor.y - value.anchor.y
        if left < 0 or top < 0 or left + value.width > request.patternGrid.width or top + value.height > request.patternGrid.height:
            raise ValueError('target outside full grid')
        if any(w > request.patternGrid.width or h > request.patternGrid.height for w, h in value.acceptableSizes):
            raise ValueError('acceptable target size exceeds full grid')


def tensorize(request: GenerationInput) -> dict:
    """Pad without resizing, cropping, or applying the target mask to context."""
    import numpy as np
    g = request.patternGrid
    rgb = np.zeros((64, 64, 3), dtype=np.uint8)
    valid = np.zeros((64, 64), dtype=np.bool_)
    occupancy = np.full((64, 64), -1, dtype=np.int8)
    rgb[:g.height, :g.width] = np.asarray(g.rgb, dtype=np.uint8).reshape(g.height, g.width, 3)
    valid[:g.height, :g.width] = True
    occupancy[:g.height, :g.width] = np.asarray([v if v is not None else -1 for v in g.occupancy]).reshape(g.height, g.width)
    return {'rgb': rgb, 'validGridMask': valid, 'occupancy': occupancy}
