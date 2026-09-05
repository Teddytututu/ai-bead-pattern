from __future__ import annotations

import io
import math
import os
import threading
import time
from contextlib import nullcontext
from dataclasses import dataclass, replace
from hashlib import sha256
from typing import Any, Protocol

import numpy as np
from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

from .contracts import (
    GROUNDING_DINO_MODEL_REPOSITORY,
    GROUNDING_DINO_MODEL_REVISION,
    MODEL_REPOSITORY,
    MODEL_REVISION,
    TRANSFORMERS_VERSION,
    InstancePrompt,
    Point,
    SegmentationRequest,
)

MAXIMUM_DIMENSION = 4096
MAXIMUM_PIXELS = 16_000_000
MASK_THRESHOLD = 0.5


@dataclass(frozen=True)
class PixelPrompt:
    box: tuple[float, float, float, float] | None
    positive_points: tuple[Point, ...]
    negative_points: tuple[Point, ...]
    source: str
    normalized_lasso: tuple[Point, ...] = ()

    def contains_lasso_point(self, point: Point) -> bool:
        return _polygon_contains(self.normalized_lasso, point)


@dataclass(frozen=True)
class BackendPrediction:
    masks: np.ndarray
    predicted_ious: np.ndarray
    inference_ms: float
    device: str


class SegmentationBackend(Protocol):
    def health(self) -> tuple[str, str]: ...

    def segment(self, image: Image.Image, prompt: PixelPrompt) -> BackendPrediction: ...

    def segment_boxes(
        self,
        image: Image.Image,
        boxes: tuple[tuple[float, float, float, float], ...],
    ) -> BackendPrediction: ...


@dataclass(frozen=True)
class Detection:
    box: tuple[float, float, float, float]
    score: float
    label: str


@dataclass(frozen=True)
class GroundingPrediction:
    detections: tuple[Detection, ...]
    inference_ms: float
    device: str


class GroundingBackend(Protocol):
    def health(self) -> tuple[str, str]: ...

    def detect(
        self,
        image: Image.Image,
        labels: tuple[str, ...],
    ) -> GroundingPrediction: ...


@dataclass(frozen=True)
class SegmentationResult:
    mask: np.ndarray
    importance_map: np.ndarray
    confidence: float
    predicted_iou: float
    stability_score: float
    prompt_agreement: float
    lasso_containment: float
    crop: tuple[int, int, int, int]
    instance_id: str
    label: str | None
    prompt_source: str
    positive_point_count: int
    negative_point_count: int
    mask_area_ratio: float
    inference_ms: float
    device: str
    detection_box: tuple[float, float, float, float] | None = None
    detection_score: float | None = None


@dataclass(frozen=True)
class SegmentationBatchResult:
    instances: tuple[SegmentationResult, ...]
    subject_mask: np.ndarray
    importance_map: np.ndarray
    crop: tuple[int, int, int, int]
    confidence: float
    inference_ms: float
    device: str
    detector_inference_ms: float = 0.0
    segmentation_inference_ms: float = 0.0

    @classmethod
    def from_instances(
        cls,
        instances: tuple[SegmentationResult, ...],
        *,
        subject_mask: np.ndarray | None = None,
        importance_map: np.ndarray | None = None,
        inference_ms: float | None = None,
        detector_inference_ms: float = 0.0,
        segmentation_inference_ms: float | None = None,
    ) -> "SegmentationBatchResult":
        if not instances:
            raise RuntimeError("Grounded SAM2 returned no instances")
        masks = tuple(np.asarray(instance.mask, dtype=np.bool_) for instance in instances)
        shapes = {mask.shape for mask in masks}
        if len(shapes) != 1:
            raise RuntimeError("Grounded SAM2 instance masks use different dimensions")
        union = (
            np.logical_or.reduce(masks)
            if subject_mask is None
            else np.asarray(subject_mask, dtype=np.bool_)
        )
        combined_importance = (
            np.maximum.reduce(tuple(instance.importance_map for instance in instances))
            if importance_map is None
            else np.asarray(importance_map, dtype=np.float32)
        )
        if union.shape != masks[0].shape or combined_importance.shape != masks[0].shape:
            raise RuntimeError("Grounded SAM2 aggregate dimensions differ from instances")
        return cls(
            instances=instances,
            subject_mask=union,
            importance_map=np.clip(combined_importance, 0.0, 1.0),
            crop=_mask_crop(union),
            confidence=float(np.mean([instance.confidence for instance in instances])),
            inference_ms=(
                float(sum(instance.inference_ms for instance in instances))
                if inference_ms is None
                else max(0.0, float(inference_ms))
            ),
            device=instances[0].device,
            detector_inference_ms=max(0.0, float(detector_inference_ms)),
            segmentation_inference_ms=(
                max(0.0, float(instances[0].inference_ms))
                if segmentation_inference_ms is None
                else max(0.0, float(segmentation_inference_ms))
            ),
        )


def _polygon_contains(polygon: tuple[Point, ...], point: Point) -> bool:
    if len(polygon) < 3:
        return False
    x, y = point
    inside = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        crosses = (y1 > y) != (y2 > y)
        if crosses:
            crossing_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < crossing_x:
                inside = not inside
        previous = current
    return inside


def _distance_to_segment(point: Point, first: Point, second: Point) -> float:
    px, py = point
    ax, ay = first
    bx, by = second
    dx = bx - ax
    dy = by - ay
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-16:
        return math.hypot(px - ax, py - ay)
    amount = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_squared))
    return math.hypot(px - (ax + amount * dx), py - (ay + amount * dy))


def _boundary_distance(polygon: tuple[Point, ...], point: Point) -> float:
    return min(
        _distance_to_segment(point, polygon[index - 1], polygon[index])
        for index in range(len(polygon))
    )


def _interior_lasso_points(polygon: tuple[Point, ...], count: int = 3) -> tuple[Point, ...]:
    left = min(point[0] for point in polygon)
    right = max(point[0] for point in polygon)
    top = min(point[1] for point in polygon)
    bottom = max(point[1] for point in polygon)
    candidates: list[Point] = []
    for y_index in range(1, 10):
        y = top + (bottom - top) * y_index / 10.0
        for x_index in range(1, 10):
            x = left + (right - left) * x_index / 10.0
            point = (x, y)
            if _polygon_contains(polygon, point):
                candidates.append(point)
    candidates.sort(key=lambda point: (-_boundary_distance(polygon, point), point[1], point[0]))
    selected: list[Point] = []
    minimum_spacing = max(0.015, math.hypot(right - left, bottom - top) * 0.12)
    for point in candidates:
        if all(math.dist(point, existing) >= minimum_spacing for existing in selected):
            selected.append(point)
            if len(selected) >= count:
                return tuple(selected)
    for point in candidates:
        if point not in selected:
            selected.append(point)
            if len(selected) >= count:
                break
    return tuple(selected)


def _outer_lasso_points(polygon: tuple[Point, ...], count: int = 4) -> tuple[Point, ...]:
    left = min(point[0] for point in polygon)
    right = max(point[0] for point in polygon)
    top = min(point[1] for point in polygon)
    bottom = max(point[1] for point in polygon)
    margin = max(0.025, max(right - left, bottom - top) * 0.08)
    center_x = (left + right) * 0.5
    center_y = (top + bottom) * 0.5
    ring = (
        (left - margin, center_y),
        (right + margin, center_y),
        (center_x, top - margin),
        (center_x, bottom + margin),
        (left - margin, top - margin),
        (right + margin, top - margin),
        (right + margin, bottom + margin),
        (left - margin, bottom + margin),
    )
    selected: list[Point] = []
    for x, y in ring:
        point = (max(0.0, min(1.0, x)), max(0.0, min(1.0, y)))
        if point not in selected and not _polygon_contains(polygon, point):
            selected.append(point)
            if len(selected) >= count:
                return tuple(selected)
    for y_index in range(11):
        for x_index in range(11):
            point = (x_index / 10.0, y_index / 10.0)
            if point not in selected and not _polygon_contains(polygon, point):
                selected.append(point)
                if len(selected) >= count:
                    return tuple(selected)
    return tuple(selected)


def _deduplicate(points: tuple[Point, ...], tolerance: float = 0.25) -> tuple[Point, ...]:
    selected: list[Point] = []
    for point in points:
        if all(math.dist(point, existing) > tolerance for existing in selected):
            selected.append(point)
    return tuple(selected)


def build_pixel_prompt(prompt: InstancePrompt, width: int, height: int) -> PixelPrompt:
    if width <= 0 or height <= 0:
        raise ValueError("source dimensions must be positive")
    box: tuple[float, float, float, float] | None = None
    if prompt.box is not None:
        x, y, box_width, box_height = prompt.box
        box = (x * width, y * height, (x + box_width) * width, (y + box_height) * height)
    elif prompt.lasso:
        box = (
            min(point[0] for point in prompt.lasso) * width,
            min(point[1] for point in prompt.lasso) * height,
            max(point[0] for point in prompt.lasso) * width,
            max(point[1] for point in prompt.lasso) * height,
        )
    generated_positive = _interior_lasso_points(prompt.lasso) if prompt.lasso else ()
    generated_negative = _outer_lasso_points(prompt.lasso) if prompt.lasso else ()

    def pixels(points: tuple[Point, ...]) -> tuple[Point, ...]:
        return tuple((
            min(width - 1.0, point[0] * width),
            min(height - 1.0, point[1] * height),
        ) for point in points)

    positive_points = _deduplicate(pixels(prompt.positive_points + generated_positive))
    negative_points = _deduplicate(pixels(prompt.negative_points + generated_negative))
    sources: list[str] = []
    if prompt.lasso:
        sources.append("lasso")
    elif prompt.box is not None:
        sources.append("box")
    if prompt.positive_points or prompt.negative_points:
        sources.append("points")
    return PixelPrompt(
        box=box,
        positive_points=positive_points,
        negative_points=negative_points,
        source="+".join(sources),
        normalized_lasso=prompt.lasso,
    )


def prepare_image(source: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(source)) as opened:
            if opened.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP")
            if (
                opened.width < 32
                or opened.height < 32
                or opened.width > MAXIMUM_DIMENSION
                or opened.height > MAXIMUM_DIMENSION
                or opened.width * opened.height > MAXIMUM_PIXELS
            ):
                raise ValueError("uploaded image dimensions exceed the SAM2 input limit")
            oriented = ImageOps.exif_transpose(opened).convert("RGBA")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP") from error
    return Image.alpha_composite(
        Image.new("RGBA", oriented.size, (255, 255, 255, 255)),
        oriented,
    ).convert("RGB")


def encode_uncompressed_rle(mask: np.ndarray) -> dict[str, list[int]]:
    binary = np.asarray(mask, dtype=np.bool_)
    if binary.ndim != 2 or binary.shape[0] == 0 or binary.shape[1] == 0:
        raise ValueError("mask must contain a two-dimensional bitmap")
    flat = binary.reshape(-1, order="F")
    counts: list[int] = []
    state = False
    run = 0
    for value in flat:
        current = bool(value)
        if current == state:
            run += 1
        else:
            counts.append(run)
            run = 1
            state = current
    counts.append(run)
    return {"size": [int(binary.shape[0]), int(binary.shape[1])], "counts": counts}


def decode_uncompressed_rle(value: dict[str, list[int]]) -> np.ndarray:
    size = value.get("size")
    counts = value.get("counts")
    if (
        not isinstance(size, list)
        or len(size) != 2
        or any(not isinstance(entry, int) or isinstance(entry, bool) or entry <= 0 for entry in size)
        or not isinstance(counts, list)
        or len(counts) == 0
        or any(not isinstance(entry, int) or isinstance(entry, bool) or entry < 0 for entry in counts)
    ):
        raise ValueError("RLE payload is invalid")
    height, width = size
    if sum(counts) != height * width:
        raise ValueError("RLE counts differ from dimensions")
    flat = np.empty(height * width, dtype=np.bool_)
    offset = 0
    state = False
    for count in counts:
        flat[offset:offset + count] = state
        offset += count
        state = not state
    return flat.reshape((height, width), order="F")


def _stability_score(probabilities: np.ndarray) -> float:
    high = int(np.count_nonzero(probabilities >= 0.55))
    low = int(np.count_nonzero(probabilities >= 0.45))
    return 0.0 if low == 0 else high / low


def _edge_importance(probabilities: np.ndarray) -> np.ndarray:
    gradient = np.zeros_like(probabilities, dtype=np.float32)
    horizontal = np.abs(probabilities[:, 1:] - probabilities[:, :-1])
    vertical = np.abs(probabilities[1:, :] - probabilities[:-1, :])
    gradient[:, 1:] = np.maximum(gradient[:, 1:], horizontal)
    gradient[:, :-1] = np.maximum(gradient[:, :-1], horizontal)
    gradient[1:, :] = np.maximum(gradient[1:, :], vertical)
    gradient[:-1, :] = np.maximum(gradient[:-1, :], vertical)
    uncertainty = 1.0 - np.abs(probabilities * 2.0 - 1.0)
    return np.clip(np.maximum(gradient, uncertainty * 0.75), 0.0, 1.0).astype(
        np.float32,
        copy=False,
    )


def _sample(mask: np.ndarray, point: Point) -> float:
    x = max(0, min(mask.shape[1] - 1, int(round(point[0]))))
    y = max(0, min(mask.shape[0] - 1, int(round(point[1]))))
    return float(mask[y, x])


def _prompt_agreement(mask: np.ndarray, prompt: PixelPrompt) -> float:
    scores = [_sample(mask, point) for point in prompt.positive_points]
    scores.extend(1.0 - _sample(mask, point) for point in prompt.negative_points)
    return 0.5 if not scores else float(np.clip(np.mean(scores), 0.0, 1.0))


def _lasso_containment(mask: np.ndarray, prompt: PixelPrompt) -> float:
    if not prompt.normalized_lasso:
        return 0.5
    binary = mask >= MASK_THRESHOLD
    area = int(np.count_nonzero(binary))
    if area == 0:
        return 0.0
    height, width = binary.shape
    raster = Image.new("1", (width, height), 0)
    ImageDraw.Draw(raster).polygon(
        [
            (point[0] * (width - 1), point[1] * (height - 1))
            for point in prompt.normalized_lasso
        ],
        fill=1,
    )
    inside = np.asarray(raster, dtype=np.bool_)
    return float(np.count_nonzero(binary & inside) / area)


def _mask_crop(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        raise RuntimeError("SAM2 returned an empty selected mask")
    height, width = mask.shape
    padding = max(2, int(round(max(width, height) * 0.03)))
    left = max(0, int(xs.min()) - padding)
    top = max(0, int(ys.min()) - padding)
    right = min(width, int(xs.max()) + 1 + padding)
    bottom = min(height, int(ys.max()) + 1 + padding)
    return left, top, right - left, bottom - top


def _box_iou(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return 0.0 if union <= 0.0 else intersection / union


def stable_detection_nms(
    detections: tuple[Detection, ...],
    *,
    iou_threshold: float = 0.7,
    maximum: int = 16,
) -> tuple[Detection, ...]:
    if not 0.0 <= iou_threshold <= 1.0:
        raise ValueError("detection NMS IoU threshold must stay within normalized bounds")
    if maximum <= 0:
        raise ValueError("maximum detection count must be positive")
    ranked = sorted(
        enumerate(detections),
        key=lambda entry: (-entry[1].score, entry[0]),
    )
    selected: list[Detection] = []
    for _source_index, detection in ranked:
        if any(_box_iou(detection.box, existing.box) > iou_threshold for existing in selected):
            continue
        selected.append(detection)
        if len(selected) >= maximum:
            break
    return tuple(selected)


def stable_instance_mask_nms(
    instances: tuple[SegmentationResult, ...],
    *,
    iou_threshold: float = 0.82,
    containment_threshold: float = 0.9,
    maximum: int = 16,
) -> tuple[SegmentationResult, ...]:
    if not 0.0 <= iou_threshold <= 1.0:
        raise ValueError("instance mask NMS IoU threshold must stay within normalized bounds")
    if not 0.0 <= containment_threshold <= 1.0:
        raise ValueError("instance mask containment threshold must stay within normalized bounds")
    if maximum <= 0:
        raise ValueError("maximum instance mask count must be positive")
    shapes = {np.asarray(instance.mask).shape for instance in instances}
    if len(shapes) > 1:
        raise RuntimeError("instance mask NMS requires matching mask dimensions")
    ranked = sorted(
        enumerate(instances),
        key=lambda entry: (
            -entry[1].confidence,
            -entry[1].predicted_iou,
            -(entry[1].detection_score or 0.0),
            entry[0],
        ),
    )
    selected: list[tuple[int, SegmentationResult]] = []
    for source_index, instance in ranked:
        candidate = np.asarray(instance.mask, dtype=np.bool_)
        candidate_area = int(candidate.sum())
        repeated = False
        for _selected_index, existing in selected:
            retained = np.asarray(existing.mask, dtype=np.bool_)
            retained_area = int(retained.sum())
            intersection = int(np.logical_and(candidate, retained).sum())
            union = candidate_area + retained_area - intersection
            smaller_area = min(candidate_area, retained_area)
            iou = 0.0 if union <= 0 else intersection / union
            containment = 0.0 if smaller_area <= 0 else intersection / smaller_area
            if iou > iou_threshold or containment > containment_threshold:
                repeated = True
                break
        if repeated:
            continue
        selected.append((source_index, instance))
        if len(selected) >= maximum:
            break
    return tuple(instance for _index, instance in sorted(selected, key=lambda entry: entry[0]))


def stable_instance_geometry_order(
    instances: tuple[SegmentationResult, ...],
) -> tuple[SegmentationResult, ...]:
    if len(instances) < 2:
        return instances
    shapes = {np.asarray(instance.mask).shape for instance in instances}
    if len(shapes) != 1:
        raise RuntimeError("instance geometry ordering requires matching mask dimensions")

    entries: list[dict[str, Any]] = []
    for source_index, instance in enumerate(instances):
        if instance.detection_box is None:
            x, y, width, height = instance.crop
            left, top, right, bottom = x, y, x + width, y + height
        else:
            left, top, right, bottom = instance.detection_box
        width = max(1.0, right - left)
        height = max(1.0, bottom - top)
        entries.append({
            "source_index": source_index,
            "instance": instance,
            "center_x": (left + right) * 0.5,
            "center_y": (top + bottom) * 0.5,
            "height": height,
            "area": width * height,
            "label": (instance.label or "").lower(),
        })

    median_height = float(np.median([entry["height"] for entry in entries]))
    row_tolerance = max(2.0, median_height * 0.35)
    rows: list[dict[str, Any]] = []
    for entry in sorted(
        entries,
        key=lambda item: (
            item["center_y"],
            item["center_x"],
            -item["area"],
            item["label"],
            item["source_index"],
        ),
    ):
        if not rows or abs(entry["center_y"] - rows[-1]["center_y"]) > row_tolerance:
            rows.append({"center_y": entry["center_y"], "entries": [entry]})
            continue
        row = rows[-1]
        row["entries"].append(entry)
        row["center_y"] = sum(item["center_y"] for item in row["entries"]) / len(row["entries"])

    ordered: list[SegmentationResult] = []
    for row in rows:
        ordered.extend(item["instance"] for item in sorted(
            row["entries"],
            key=lambda item: (
                item["center_x"],
                -item["area"],
                item["label"],
                item["center_y"],
                item["source_index"],
            ),
        ))
    return tuple(ordered)


def normalize_detection_labels(labels: tuple[str, ...]) -> tuple[str, ...]:
    normalized: list[str] = []
    for label in labels:
        value = label.strip().lower().rstrip(".").strip()
        for article in ("a ", "an ", "the "):
            if value.startswith(article):
                value = value[len(article):].strip()
                break
        if not value:
            raise ValueError("GroundingDINO labels must contain visible text")
        if value not in normalized:
            normalized.append(value)
    if not normalized or len(normalized) > 16:
        raise ValueError("GroundingDINO labels must contain 1..16 unique entries")
    return tuple(normalized)


def _environment_unit(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    try:
        value = float(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be numeric") from error
    if value < 0.0 or value > 1.0:
        raise RuntimeError(f"{name} must stay within normalized bounds")
    return value


class TransformersGroundingDinoBackend:
    def __init__(
        self,
        device: str | None = None,
        *,
        box_threshold: float | None = None,
        text_threshold: float | None = None,
        nms_iou_threshold: float = 0.7,
        maximum_instances: int = 16,
    ) -> None:
        self._requested_device = device
        self._device: Any | None = None
        self._model: Any | None = None
        self._processor: Any | None = None
        self._box_threshold = (
            _environment_unit("GROUNDING_DINO_BOX_THRESHOLD", 0.35)
            if box_threshold is None
            else box_threshold
        )
        self._text_threshold = (
            _environment_unit("GROUNDING_DINO_TEXT_THRESHOLD", 0.25)
            if text_threshold is None
            else text_threshold
        )
        if not 0.0 <= self._box_threshold <= 1.0 or not 0.0 <= self._text_threshold <= 1.0:
            raise ValueError("GroundingDINO thresholds must stay within normalized bounds")
        if not 0.0 <= nms_iou_threshold <= 1.0:
            raise ValueError("GroundingDINO NMS threshold must stay within normalized bounds")
        if maximum_instances <= 0 or maximum_instances > 64:
            raise ValueError("GroundingDINO instance limit must stay within 1..64")
        self._nms_iou_threshold = nms_iou_threshold
        self._maximum_instances = maximum_instances
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def _weights_cached(self) -> bool:
        """Check every pinned GroundingDINO asset before advertising degraded."""
        try:
            from huggingface_hub import try_to_load_from_cache
            required = (
                "config.json",
                "model.safetensors",
                "preprocessor_config.json",
                "added_tokens.json",
                "special_tokens_map.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "vocab.txt",
            )
            return all(
                isinstance(
                    try_to_load_from_cache(
                        GROUNDING_DINO_MODEL_REPOSITORY,
                        filename,
                        revision=GROUNDING_DINO_MODEL_REVISION,
                    ),
                    str,
                )
                for filename in required
            )
        except Exception:
            return False

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            try:
                import torch
                import transformers
                from transformers import (
                    GroundingDinoForObjectDetection,
                    GroundingDinoProcessor,
                )

                if transformers.__version__ != TRANSFORMERS_VERSION:
                    raise RuntimeError(
                        f"transformers {transformers.__version__} differs from {TRANSFORMERS_VERSION}"
                    )
                selected = self._requested_device or os.environ.get("SAM2_DEVICE")
                device = torch.device(selected or ("cuda" if torch.cuda.is_available() else "cpu"))
                dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
                local_files_only = os.environ.get("SAM2_ALLOW_RUNTIME_DOWNLOAD", "0") != "1"
                model = GroundingDinoForObjectDetection.from_pretrained(
                    GROUNDING_DINO_MODEL_REPOSITORY,
                    revision=GROUNDING_DINO_MODEL_REVISION,
                    dtype=dtype,
                    low_cpu_mem_usage=True,
                    local_files_only=local_files_only,
                ).to(device)
                model.eval()
                processor = GroundingDinoProcessor.from_pretrained(
                    GROUNDING_DINO_MODEL_REPOSITORY,
                    revision=GROUNDING_DINO_MODEL_REVISION,
                    local_files_only=local_files_only,
                )
                self._model = model
                self._processor = processor
                self._device = device
            except Exception as error:
                detail = " ".join(str(error).split())[:500]
                raise RuntimeError(f"GroundingDINO model load failed: {detail}") from error

    def health(self) -> tuple[str, str]:
        try:
            import torch
            import transformers
        except Exception as error:
            return "unavailable", f"runtime import failed: {error}"
        selected = self._requested_device or os.environ.get("SAM2_DEVICE")
        device = selected or ("cuda" if torch.cuda.is_available() else "cpu")
        if transformers.__version__ != TRANSFORMERS_VERSION:
            return "unavailable", (
                f"transformers {transformers.__version__} differs from {TRANSFORMERS_VERSION}"
            )
        if self._model is None and not self._weights_cached():
            return "unavailable", (
                "pinned GroundingDINO weights are absent from the local cache; "
                "run the sidecar prefetch command"
            )
        if self._model is None:
            return "degraded", f"pinned GroundingDINO weights load on first request; device={device}"
        return "ready", f"GroundingDINO ready; device={self._device}"

    def detect(
        self,
        image: Image.Image,
        labels: tuple[str, ...],
    ) -> GroundingPrediction:
        normalized_labels = normalize_detection_labels(labels)
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._processor is not None
        assert self._device is not None
        device_type = getattr(self._device, "type", str(self._device).split(":", 1)[0])
        with self._inference_lock:
            started = time.perf_counter()
            inputs = self._processor(
                images=image,
                text=list(normalized_labels),
                return_tensors="pt",
            ).to(self._device)
            autocast = (
                torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                if device_type == "cuda"
                else nullcontext()
            )
            with torch.inference_mode(), autocast:
                outputs = self._model(**inputs)
            processed = self._processor.post_process_grounded_object_detection(
                outputs,
                input_ids=inputs["input_ids"],
                threshold=self._box_threshold,
                text_threshold=self._text_threshold,
                target_sizes=[(image.height, image.width)],
            )[0]
            elapsed_ms = (time.perf_counter() - started) * 1000.0
        raw_scores = processed.get("scores", ())
        raw_boxes = processed.get("boxes", ())
        raw_labels = processed.get("text_labels")
        if raw_labels is None:
            raw_labels = processed.get("labels", ())

        def array(value: Any) -> np.ndarray:
            if hasattr(value, "detach"):
                value = value.detach().float().cpu().numpy()
            return np.asarray(value)

        scores = array(raw_scores).reshape(-1)
        boxes = array(raw_boxes).reshape((-1, 4))
        labels_output = list(raw_labels)
        if scores.shape[0] != boxes.shape[0] or scores.shape[0] != len(labels_output):
            raise RuntimeError("GroundingDINO output fields use different lengths")
        detections: list[Detection] = []
        for score, box, label in zip(scores, boxes, labels_output):
            score_value = float(score)
            values = tuple(float(entry) for entry in box)
            label_value = str(label).strip()
            if not math.isfinite(score_value) or not all(math.isfinite(entry) for entry in values):
                raise RuntimeError("GroundingDINO output contains non-finite values")
            left = max(0.0, min(float(image.width), values[0]))
            top = max(0.0, min(float(image.height), values[1]))
            right = max(0.0, min(float(image.width), values[2]))
            bottom = max(0.0, min(float(image.height), values[3]))
            if right <= left or bottom <= top or not label_value:
                continue
            detections.append(Detection(
                box=(left, top, right, bottom),
                score=float(np.clip(score_value, 0.0, 1.0)),
                label=label_value,
            ))
        return GroundingPrediction(
            detections=stable_detection_nms(
                tuple(detections),
                iou_threshold=self._nms_iou_threshold,
                maximum=self._maximum_instances,
            ),
            inference_ms=max(0.0, elapsed_ms),
            device=str(self._device),
        )


class TransformersSam2Backend:
    def __init__(self, device: str | None = None) -> None:
        self._requested_device = device
        self._device = None
        self._model: Any | None = None
        self._processor: Any | None = None
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def _weights_cached(self) -> bool:
        """Check every pinned SAM2 asset before advertising degraded."""
        try:
            from huggingface_hub import try_to_load_from_cache
            required = (
                "config.json",
                "model.safetensors",
                "preprocessor_config.json",
                "processor_config.json",
            )
            return all(
                isinstance(
                    try_to_load_from_cache(
                        MODEL_REPOSITORY,
                        filename,
                        revision=MODEL_REVISION,
                    ),
                    str,
                )
                for filename in required
            )
        except Exception:
            return False

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            try:
                import torch
                import transformers
                from transformers import Sam2Model, Sam2Processor

                os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
                if transformers.__version__ != TRANSFORMERS_VERSION:
                    raise RuntimeError(
                        f"transformers {transformers.__version__} differs from {TRANSFORMERS_VERSION}"
                    )
                selected = self._requested_device or os.environ.get("SAM2_DEVICE")
                device = torch.device(selected or ("cuda" if torch.cuda.is_available() else "cpu"))
                dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
                local_files_only = os.environ.get("SAM2_ALLOW_RUNTIME_DOWNLOAD", "0") != "1"
                model = Sam2Model.from_pretrained(
                    MODEL_REPOSITORY,
                    revision=MODEL_REVISION,
                    dtype=dtype,
                    low_cpu_mem_usage=True,
                    local_files_only=local_files_only,
                ).to(device)
                model.eval()
                processor = Sam2Processor.from_pretrained(
                    MODEL_REPOSITORY,
                    revision=MODEL_REVISION,
                    local_files_only=local_files_only,
                )
                self._model = model
                self._processor = processor
                self._device = device
            except Exception as error:
                detail = " ".join(str(error).split())[:500]
                raise RuntimeError(f"SAM2 model load failed: {detail}") from error

    def health(self) -> tuple[str, str]:
        try:
            import torch
            import transformers
        except Exception as error:
            return "unavailable", f"runtime import failed: {error}"
        selected = self._requested_device or os.environ.get("SAM2_DEVICE")
        device = selected or ("cuda" if torch.cuda.is_available() else "cpu")
        if transformers.__version__ != TRANSFORMERS_VERSION:
            return "unavailable", (
                f"transformers {transformers.__version__} differs from {TRANSFORMERS_VERSION}"
            )
        if self._model is None and not self._weights_cached():
            return "unavailable", (
                "pinned SAM2 weights are absent from the local cache; "
                "run the sidecar prefetch command"
            )
        if self._model is None:
            return "degraded", f"pinned SAM2 weights load on first request; device={device}"
        return "ready", f"SAM2 ready; device={self._device}"

    def segment(self, image: Image.Image, prompt: PixelPrompt) -> BackendPrediction:
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._processor is not None
        assert self._device is not None
        arguments: dict[str, Any] = {"images": image, "return_tensors": "pt"}
        if prompt.box is not None:
            arguments["input_boxes"] = [[[float(value) for value in prompt.box]]]
        points = prompt.positive_points + prompt.negative_points
        if points:
            arguments["input_points"] = [[[[float(x), float(y)] for x, y in points]]]
            arguments["input_labels"] = [[[
                *([1] * len(prompt.positive_points)),
                *([0] * len(prompt.negative_points)),
            ]]]
        with self._inference_lock:
            inputs = self._processor(**arguments).to(self._device)
            autocast = (
                torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                if self._device.type == "cuda"
                else nullcontext()
            )
            started = time.perf_counter()
            with torch.inference_mode(), autocast:
                outputs = self._model(**inputs, multimask_output=True)
            processed = self._processor.post_process_masks(
                outputs.pred_masks.detach().float().cpu(),
                inputs["original_sizes"].detach().cpu(),
                binarize=False,
            )[0]
        probabilities = torch.sigmoid(processed[0]).numpy().astype(np.float32, copy=False)
        predicted_ious = outputs.iou_scores.detach().float().cpu().numpy()[0, 0]
        if probabilities.ndim == 2:
            probabilities = probabilities[np.newaxis, ...]
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return BackendPrediction(
            masks=probabilities,
            predicted_ious=np.asarray(predicted_ious, dtype=np.float32).reshape(-1),
            inference_ms=elapsed_ms,
            device=str(self._device),
        )

    def segment_boxes(
        self,
        image: Image.Image,
        boxes: tuple[tuple[float, float, float, float], ...],
    ) -> BackendPrediction:
        if not boxes:
            raise ValueError("SAM2 box batch must contain at least one box")
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._processor is not None
        assert self._device is not None
        arguments = {
            "images": image,
            "input_boxes": [[list(box) for box in boxes]],
            "return_tensors": "pt",
        }
        with self._inference_lock:
            inputs = self._processor(**arguments).to(self._device)
            autocast = (
                torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                if self._device.type == "cuda"
                else nullcontext()
            )
            started = time.perf_counter()
            with torch.inference_mode(), autocast:
                outputs = self._model(**inputs, multimask_output=False)
            processed = self._processor.post_process_masks(
                outputs.pred_masks.detach().float().cpu(),
                inputs["original_sizes"].detach().cpu(),
                binarize=False,
            )[0]
        probabilities = torch.sigmoid(processed[:, 0]).numpy().astype(np.float32, copy=False)
        predicted_ious = outputs.iou_scores.detach().float().cpu().numpy()[0, :, 0]
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return BackendPrediction(
            masks=probabilities,
            predicted_ious=np.asarray(predicted_ious, dtype=np.float32).reshape(-1),
            inference_ms=elapsed_ms,
            device=str(self._device),
        )


class Sam2SegmentationEngine:
    def __init__(
        self,
        backend: SegmentationBackend | None = None,
        detector: GroundingBackend | None = None,
    ) -> None:
        self._backend = backend or TransformersSam2Backend()
        self._detector = detector or TransformersGroundingDinoBackend()

    def health(self) -> tuple[str, str]:
        return self._backend.health()

    def grounded_health(self) -> tuple[str, str]:
        sam_status, sam_message = self._backend.health()
        detector_status, detector_message = self._detector.health()
        statuses = (sam_status, detector_status)
        if "unavailable" in statuses:
            status = "unavailable"
        elif "degraded" in statuses:
            status = "degraded"
        else:
            status = "ready"
        return status, f"{detector_message}; {sam_message}"

    def analyze(
        self,
        source: bytes,
        request: SegmentationRequest,
    ) -> SegmentationBatchResult:
        if request.automatic_detection:
            return self._segment_detected(source, request)
        result = self.segment(source, request)
        return SegmentationBatchResult.from_instances(
            (result,),
            inference_ms=result.inference_ms,
        )

    def _segment_detected(
        self,
        source: bytes,
        request: SegmentationRequest,
    ) -> SegmentationBatchResult:
        image = prepare_image(source)
        grounding = self._detector.detect(image, request.prompt.labels)
        if not grounding.detections:
            raise RuntimeError("GroundingDINO found no matching pet instances")
        boxes = tuple(detection.box for detection in grounding.detections)
        prediction = self._backend.segment_boxes(image, boxes)
        masks = np.asarray(prediction.masks, dtype=np.float32)
        ious = np.asarray(prediction.predicted_ious, dtype=np.float32).reshape(-1)
        if (
            masks.ndim != 3
            or masks.shape[0] != len(grounding.detections)
            or masks.shape[1:] != (image.height, image.width)
            or ious.shape[0] != len(grounding.detections)
        ):
            raise RuntimeError("Grounded SAM2 masks, boxes, and IoU scores differ in count or dimensions")
        if not np.isfinite(masks).all() or not np.isfinite(ious).all():
            raise RuntimeError("Grounded SAM2 output contains non-finite values")
        masks = np.clip(masks, 0.0, 1.0)
        ious = np.clip(ious, 0.0, 1.0)
        instances: list[SegmentationResult] = []
        for index, (detection, probabilities) in enumerate(
            zip(grounding.detections, masks),
        ):
            selected = probabilities >= MASK_THRESHOLD
            if not selected.any():
                continue
            stability = _stability_score(probabilities)
            confidence = (
                0.45 * detection.score
                + 0.4 * float(ious[index])
                + 0.15 * stability
            )
            instances.append(SegmentationResult(
                mask=selected,
                importance_map=_edge_importance(probabilities),
                confidence=float(np.clip(confidence, 0.0, 1.0)),
                predicted_iou=float(ious[index]),
                stability_score=float(stability),
                prompt_agreement=1.0,
                lasso_containment=0.5,
                crop=_mask_crop(selected),
                instance_id=f"pet-{index + 1:02d}",
                label=detection.label,
                prompt_source="text+box",
                positive_point_count=0,
                negative_point_count=0,
                mask_area_ratio=float(selected.mean()),
                inference_ms=max(0.0, float(prediction.inference_ms)),
                device=prediction.device,
                detection_box=detection.box,
                detection_score=detection.score,
            ))
        deduplicated = stable_instance_mask_nms(tuple(instances))
        geometry_ordered = stable_instance_geometry_order(deduplicated)
        normalized = tuple(
            replace(instance, instance_id=f"pet-{index + 1:02d}")
            for index, instance in enumerate(geometry_ordered)
        )
        return SegmentationBatchResult.from_instances(
            normalized,
            inference_ms=max(0.0, grounding.inference_ms + prediction.inference_ms),
            detector_inference_ms=grounding.inference_ms,
            segmentation_inference_ms=prediction.inference_ms,
        )

    def segment(self, source: bytes, request: SegmentationRequest) -> SegmentationResult:
        image = prepare_image(source)
        prompt = build_pixel_prompt(request.prompt, image.width, image.height)
        prediction = self._backend.segment(image, prompt)
        masks = np.asarray(prediction.masks, dtype=np.float32)
        ious = np.asarray(prediction.predicted_ious, dtype=np.float32).reshape(-1)
        if (
            masks.ndim != 3
            or masks.shape[0] == 0
            or masks.shape[1:] != (image.height, image.width)
            or ious.shape[0] != masks.shape[0]
        ):
            raise RuntimeError("SAM2 mask dimensions differ from the source or IoU scores")
        if not np.isfinite(masks).all() or not np.isfinite(ious).all():
            raise RuntimeError("SAM2 output contains non-finite values")
        masks = np.clip(masks, 0.0, 1.0)
        ious = np.clip(ious, 0.0, 1.0)
        ranked: list[tuple[float, int, float, float, float]] = []
        for index, mask in enumerate(masks):
            stability = _stability_score(mask)
            agreement = _prompt_agreement(mask, prompt)
            containment = _lasso_containment(mask, prompt)
            score = (
                0.65 * float(ious[index])
                + 0.15 * stability
                + 0.1 * agreement
            )
            if prompt.normalized_lasso:
                score += 0.1 * containment
            else:
                score /= 0.9
            ranked.append((score, index, stability, agreement, containment))
        confidence, index, stability, agreement, containment = max(
            ranked,
            key=lambda entry: (entry[0], -entry[1]),
        )
        selected = masks[index] >= MASK_THRESHOLD
        importance_map = _edge_importance(masks[index])
        crop = _mask_crop(selected)
        instance_id = request.prompt.selected_instance_id
        if instance_id is None:
            digest = sha256(source + repr(request.prompt).encode("utf-8")).hexdigest()[:12]
            instance_id = f"sam2-prompt-{digest}"
        return SegmentationResult(
            mask=selected,
            importance_map=importance_map,
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            predicted_iou=float(ious[index]),
            stability_score=float(stability),
            prompt_agreement=float(agreement),
            lasso_containment=float(containment),
            crop=crop,
            instance_id=instance_id,
            label=request.prompt.labels[0] if request.prompt.labels else None,
            prompt_source=prompt.source,
            positive_point_count=len(prompt.positive_points),
            negative_point_count=len(prompt.negative_points),
            mask_area_ratio=float(selected.mean()),
            inference_ms=max(0.0, float(prediction.inference_ms)),
            device=prediction.device,
        )
