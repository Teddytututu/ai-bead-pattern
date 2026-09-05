from __future__ import annotations

import io
import os
import threading
import time
from collections import OrderedDict
from contextlib import nullcontext
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Literal, Protocol, Sequence

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .contracts import (
    EMBEDDING_DIMENSIONS,
    INPUT_SIZE,
    MODEL_REPOSITORY,
    PATCH_SIZE,
    WEIGHT_REVISION,
)

MAXIMUM_DIMENSION = 4096
MAXIMUM_PIXELS = 16_000_000
VIEW_NAMES = ("global", "subject", "head", "critical-local")
ViewName = Literal["global", "subject", "head", "critical-local"]


@dataclass(frozen=True)
class NormalizedBox:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class DinoEncodedView:
    global_features: np.ndarray
    patch_features: np.ndarray
    patch_salience: np.ndarray | None = None


@dataclass(frozen=True)
class FeatureComparison:
    identity_similarity: float
    patch_correspondence: float
    critical_patch_retention: float
    regional_coverage: float
    confidence: float


@dataclass(frozen=True)
class RegionalPairScore:
    view: ViewName
    identity_similarity: float
    patch_correspondence: float
    critical_patch_retention: float
    regional_coverage: float
    confidence: float


@dataclass(frozen=True)
class PairScore:
    views: tuple[RegionalPairScore, ...]
    confidence: float
    inference_ms: float
    cache_hits: int

    def _weighted(self, field: str) -> float:
        weights = (0.35, 0.30, 0.20, 0.15)
        return float(sum(
            weight * float(getattr(view, field))
            for weight, view in zip(weights, self.views)
        ))

    @property
    def identity_similarity(self) -> float:
        return self._weighted("identity_similarity")

    @property
    def patch_correspondence(self) -> float:
        return self._weighted("patch_correspondence")

    @property
    def critical_patch_retention(self) -> float:
        return self._weighted("critical_patch_retention")

    @property
    def regional_coverage(self) -> float:
        return self._weighted("regional_coverage")


class DinoBackend(Protocol):
    def health(self) -> tuple[str, str]: ...

    def encode(self, images: list[Image.Image]) -> list[DinoEncodedView]: ...


def _decode_image(source: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(source)) as opened:
            if opened.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP")
            if opened.width < 1 or opened.height < 1:
                raise ValueError("uploaded image dimensions must be positive")
            if (
                opened.width > MAXIMUM_DIMENSION
                or opened.height > MAXIMUM_DIMENSION
                or opened.width * opened.height > MAXIMUM_PIXELS
            ):
                raise ValueError("uploaded image dimensions exceed the DINOv2 input limit")
            oriented = ImageOps.exif_transpose(opened).convert("RGBA")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP") from error
    return Image.alpha_composite(
        Image.new("RGBA", oriented.size, (255, 255, 255, 255)),
        oriented,
    ).convert("RGB")


def _fit_patch_canvas(image: Image.Image) -> Image.Image:
    fitted = ImageOps.contain(
        image,
        (INPUT_SIZE, INPUT_SIZE),
        Image.Resampling.LANCZOS,
    )
    canvas_width = ((INPUT_SIZE + PATCH_SIZE - 1) // PATCH_SIZE) * PATCH_SIZE
    canvas_height = ((INPUT_SIZE + PATCH_SIZE - 1) // PATCH_SIZE) * PATCH_SIZE
    canvas = Image.new("RGB", (canvas_width, canvas_height), (255, 255, 255))
    canvas.paste(
        fitted,
        ((canvas_width - fitted.width) // 2, (canvas_height - fitted.height) // 2),
    )
    return canvas


def prepare_image(source: bytes) -> Image.Image:
    return _fit_patch_canvas(_decode_image(source))


def _clamped_box(x: float, y: float, width: float, height: float) -> NormalizedBox:
    x = float(np.clip(x, 0.0, 1.0))
    y = float(np.clip(y, 0.0, 1.0))
    width = float(np.clip(width, 1e-3, 1.0 - x))
    height = float(np.clip(height, 1e-3, 1.0 - y))
    return NormalizedBox(x, y, width, height)


def _subject_box(image: Image.Image) -> NormalizedBox:
    pixels = np.asarray(image.resize((96, 96), Image.Resampling.BILINEAR), dtype=np.float32)
    border = np.concatenate((
        pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1],
    ), axis=0)
    background = np.median(border, axis=0)
    distance = np.linalg.norm(pixels - background, axis=2)
    threshold = max(18.0, float(np.percentile(distance, 68)))
    mask = distance > threshold
    if int(mask.sum()) < 32:
        return NormalizedBox(0.0, 0.0, 1.0, 1.0)
    ys, xs = np.nonzero(mask)
    left = max(0, int(xs.min()) - 4)
    right = min(95, int(xs.max()) + 4)
    top = max(0, int(ys.min()) - 4)
    bottom = min(95, int(ys.max()) + 4)
    return _clamped_box(
        left / 96,
        top / 96,
        (right - left + 1) / 96,
        (bottom - top + 1) / 96,
    )


def _head_box(subject: NormalizedBox) -> NormalizedBox:
    width = subject.width * 0.72
    height = subject.height * 0.58
    x = subject.x + (subject.width - width) * 0.5
    y = subject.y
    return _clamped_box(x, y, width, height)


def _critical_box(image: Image.Image, subject: NormalizedBox) -> NormalizedBox:
    gray = np.asarray(image.convert("L").resize((96, 96), Image.Resampling.BILINEAR), dtype=np.float32)
    left = int(subject.x * 96)
    top = int(subject.y * 96)
    right = max(left + 1, int((subject.x + subject.width) * 96))
    bottom = max(top + 1, int((subject.y + subject.height) * 96))
    x_gradient = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
    y_gradient = np.abs(np.diff(gray, axis=0, prepend=gray[:1, :]))
    energy = x_gradient + y_gradient
    region = energy[top:bottom, left:right]
    peak_y, peak_x = np.unravel_index(int(np.argmax(region)), region.shape)
    center_x = (left + peak_x + 0.5) / 96
    center_y = (top + peak_y + 0.5) / 96
    size = max(0.18, min(subject.width, subject.height) * 0.42)
    return _clamped_box(center_x - size / 2, center_y - size / 2, size, size)


def _view_boxes(image: Image.Image) -> tuple[tuple[ViewName, NormalizedBox], ...]:
    subject = _subject_box(image)
    return (
        ("global", NormalizedBox(0.0, 0.0, 1.0, 1.0)),
        ("subject", subject),
        ("head", _head_box(subject)),
        ("critical-local", _critical_box(image, subject)),
    )


def _crop(image: Image.Image, box: NormalizedBox) -> Image.Image:
    left = int(round(box.x * image.width))
    top = int(round(box.y * image.height))
    right = max(left + 1, int(round((box.x + box.width) * image.width)))
    bottom = max(top + 1, int(round((box.y + box.height) * image.height)))
    return image.crop((left, top, min(image.width, right), min(image.height, bottom)))


def _prepared_views(image: Image.Image) -> list[Image.Image]:
    return [_fit_patch_canvas(_crop(image, box)) for _name, box in _view_boxes(image)]


def _normalized_vector(values: np.ndarray, label: str) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float32).reshape(-1)
    if vector.size == 0 or not np.isfinite(vector).all():
        raise RuntimeError(f"{label} must contain finite features")
    length = float(np.linalg.norm(vector))
    if length <= 1e-12:
        raise RuntimeError(f"{label} contains an empty feature vector")
    return vector / length


def _normalized_rows(values: np.ndarray, label: str) -> np.ndarray:
    rows = np.asarray(values, dtype=np.float32)
    if rows.ndim != 2 or rows.shape[0] == 0 or rows.shape[1] == 0:
        raise RuntimeError(f"{label} must contain a non-empty feature matrix")
    if not np.isfinite(rows).all():
        raise RuntimeError(f"{label} contains non-finite features")
    lengths = np.linalg.norm(rows, axis=1, keepdims=True)
    if np.any(lengths <= 1e-12):
        raise RuntimeError(f"{label} contains an empty feature vector")
    return rows / lengths


def _unit_cosine(values: np.ndarray) -> np.ndarray:
    return np.clip((values + 1.0) * 0.5, 0.0, 1.0)


def _salience_weights(values: np.ndarray | None, count: int) -> np.ndarray:
    if values is None:
        return np.full(count, 1.0 / count, dtype=np.float32)
    weights = np.asarray(values, dtype=np.float32).reshape(-1)
    if weights.shape[0] != count or not np.isfinite(weights).all() or np.any(weights < 0):
        raise RuntimeError("DINOv2 patch salience differs from patch features")
    total = float(weights.sum())
    if total <= 1e-12:
        return np.full(count, 1.0 / count, dtype=np.float32)
    return weights / total


def _patch_salience(image: Image.Image) -> np.ndarray:
    pixels = np.asarray(image, dtype=np.float32)
    border = np.concatenate((pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]), axis=0)
    background = np.median(border, axis=0)
    grid = INPUT_SIZE // PATCH_SIZE
    scores = np.zeros(grid * grid, dtype=np.float32)
    for patch_y in range(grid):
        for patch_x in range(grid):
            patch = pixels[
                patch_y * PATCH_SIZE:(patch_y + 1) * PATCH_SIZE,
                patch_x * PATCH_SIZE:(patch_x + 1) * PATCH_SIZE,
            ]
            foreground = float(np.linalg.norm(patch.mean(axis=(0, 1)) - background) / 441.7)
            texture = float(np.mean(np.std(patch, axis=(0, 1))) / 128.0)
            scores[patch_y * grid + patch_x] = 0.72 * foreground + 0.28 * texture
    maximum = float(scores.max())
    if maximum > 1e-12:
        scores /= maximum
    return scores


def _grid_shape(count: int) -> tuple[int, int] | None:
    """Return the ViT patch grid when the token count forms a regular grid."""
    side = int(round(float(np.sqrt(count))))
    if side * side != count:
        return None
    return side, side


def _spatially_constrained_best(
    similarity: np.ndarray,
    *,
    reference_count: int,
    candidate_count: int,
) -> np.ndarray:
    """Match patches within a one-cell neighbourhood before using global evidence.

    A global maximum lets a candidate copy one salient patch into every location.
    The neighbourhood constraint preserves coarse spatial correspondence while the
    global fallback keeps support for rectangular/cropped views with unequal grids.
    """
    reference_grid = _grid_shape(reference_count)
    candidate_grid = _grid_shape(candidate_count)
    if reference_grid is None or candidate_grid is None:
        return np.max(similarity, axis=1)
    ref_h, ref_w = reference_grid
    cand_h, cand_w = candidate_grid
    best = np.empty(reference_count, dtype=np.float32)
    for index in range(reference_count):
        ref_y, ref_x = divmod(index, ref_w)
        # Coordinates are compared in normalized image space so grids of different
        # sizes retain correspondence after cropping and padding.
        ref_y_norm = (ref_y + 0.5) / ref_h
        ref_x_norm = (ref_x + 0.5) / ref_w
        radius_y = 1.01 / ref_h
        radius_x = 1.01 / ref_w
        allowed: list[int] = []
        for candidate_index in range(candidate_count):
            cand_y, cand_x = divmod(candidate_index, cand_w)
            cand_y_norm = (cand_y + 0.5) / cand_h
            cand_x_norm = (cand_x + 0.5) / cand_w
            normalized_distance = (
                ((ref_y_norm - cand_y_norm) / radius_y) ** 2
                + ((ref_x_norm - cand_x_norm) / radius_x) ** 2
            ) ** 0.5
            if normalized_distance <= 1.0:
                allowed.append(candidate_index)
        if allowed:
            best[index] = float(np.max(similarity[index, allowed]))
        else:
            best[index] = float(np.max(similarity[index]))
    return best


def compare_feature_sets(
    reference: DinoEncodedView,
    candidate: DinoEncodedView,
) -> FeatureComparison:
    reference_global = _normalized_vector(reference.global_features, "DINOv2 reference CLS")
    candidate_global = _normalized_vector(candidate.global_features, "DINOv2 candidate CLS")
    reference_patches = _normalized_rows(reference.patch_features, "DINOv2 reference patches")
    candidate_patches = _normalized_rows(candidate.patch_features, "DINOv2 candidate patches")
    if reference_global.shape != candidate_global.shape:
        raise RuntimeError("DINOv2 pair CLS dimensions differ")
    if reference_patches.shape[1] != candidate_patches.shape[1]:
        raise RuntimeError("DINOv2 pair patch dimensions differ")
    if reference_global.shape[0] != reference_patches.shape[1]:
        raise RuntimeError("DINOv2 CLS and patch dimensions differ")

    identity = float(_unit_cosine(np.dot(reference_global, candidate_global)))
    similarity = _unit_cosine(reference_patches @ candidate_patches.T)
    reference_weights = _salience_weights(reference.patch_salience, reference_patches.shape[0])
    candidate_weights = _salience_weights(candidate.patch_salience, candidate_patches.shape[0])
    reference_best = _spatially_constrained_best(
        similarity,
        reference_count=reference_patches.shape[0],
        candidate_count=candidate_patches.shape[0],
    )
    candidate_best = _spatially_constrained_best(
        similarity.T,
        reference_count=candidate_patches.shape[0],
        candidate_count=reference_patches.shape[0],
    )
    patch_correspondence = float(
        (
            np.dot(reference_best, reference_weights)
            + np.dot(candidate_best, candidate_weights)
        ) * 0.5
    )

    source_detail = 1.0 - np.abs(reference_patches @ reference_global)
    if reference.patch_salience is not None and float(np.max(reference.patch_salience)) > 1e-12:
        source_detail = np.asarray(reference.patch_salience, dtype=np.float32)
    critical_count = min(
        reference_patches.shape[0],
        max(2, int(np.ceil(reference_patches.shape[0] * 0.25))),
    )
    critical_indices = np.argpartition(source_detail, -critical_count)[-critical_count:]
    critical_best = reference_best[critical_indices]
    critical_retention = float(critical_best.mean())
    soft_coverage = np.clip((reference_best - 0.5) * 2.0, 0.0, 1.0)
    regional_coverage = float(np.dot(soft_coverage, reference_weights))
    detail_spread = float(np.clip(np.std(source_detail) * 4.0, 0.0, 1.0))
    patch_support = float(np.clip(reference_patches.shape[0] / 16.0, 0.0, 1.0))
    # Confidence reflects observed agreement and usable local evidence. A fixed
    # floor would make weak or collapsed candidates appear trustworthy.
    confidence = float(np.clip(
        0.45 * identity
        + 0.30 * patch_correspondence
        + 0.15 * regional_coverage
        + 0.10 * (0.5 * patch_support + 0.5 * detail_spread),
        0.0,
        1.0,
    ))
    return FeatureComparison(
        identity_similarity=identity,
        patch_correspondence=patch_correspondence,
        critical_patch_retention=critical_retention,
        regional_coverage=regional_coverage,
        confidence=confidence,
    )


class DinoV2Backend:
    def __init__(
        self,
        device: str | None = None,
        cache_dir: str | Path | None = None,
    ) -> None:
        self._requested_device = device
        self._cache_dir = None if cache_dir is None else str(cache_dir)
        self._model = None
        self._device = None
        self._load_lock = threading.Lock()

    def _runtime_health(self) -> tuple[bool, str]:
        try:
            import torch
            import transformers
        except Exception as error:
            return False, f"runtime import failed: {error}"
        requested = self._requested_device or os.environ.get("DINOV2_DEVICE")
        selected = requested or ("cuda" if torch.cuda.is_available() else "cpu")
        return True, f"transformers {transformers.__version__} ready; device={selected}"

    def _weights_cached(self) -> bool:
        try:
            from huggingface_hub import try_to_load_from_cache

            config = try_to_load_from_cache(
                MODEL_REPOSITORY,
                "config.json",
                revision=WEIGHT_REVISION,
                cache_dir=self._cache_dir,
            )
            weights = try_to_load_from_cache(
                MODEL_REPOSITORY,
                "model.safetensors",
                revision=WEIGHT_REVISION,
                cache_dir=self._cache_dir,
            )
        except Exception:
            return False
        return isinstance(config, str) and isinstance(weights, str)

    def health(self) -> tuple[str, str]:
        runtime_ready, runtime_message = self._runtime_health()
        if not runtime_ready:
            return "unavailable", runtime_message
        if self._model is not None:
            return "ready", f"DINOv2 ViT-S/14 ready; device={self._device}"
        if not self._weights_cached():
            return "unavailable", (
                "pinned DINOv2 weights are absent from the local cache; "
                "run the sidecar prefetch command"
            )
        return "degraded", f"{runtime_message}; pinned weights load on first request"

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            try:
                import torch
                from transformers import Dinov2Model

                requested = self._requested_device or os.environ.get("DINOV2_DEVICE")
                device = requested or ("cuda" if torch.cuda.is_available() else "cpu")
                allow_download = os.environ.get("DINOV2_ALLOW_DOWNLOAD", "0") == "1"
                model = Dinov2Model.from_pretrained(
                    MODEL_REPOSITORY,
                    revision=WEIGHT_REVISION,
                    cache_dir=self._cache_dir,
                    local_files_only=not allow_download,
                )
                model.eval().to(device)
                self._model = model
                self._device = torch.device(device)
            except Exception as error:
                detail = " ".join(str(error).split())[:500]
                raise RuntimeError(f"DINOv2 model load failed: {detail}") from error

    def _autocast(self):
        assert self._device is not None
        if self._device.type == "cuda":
            import torch

            return torch.autocast(device_type="cuda", dtype=torch.float16)
        return nullcontext()

    def encode(self, images: list[Image.Image]) -> list[DinoEncodedView]:
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._device is not None
        arrays = []
        for image in images:
            if image.size != (INPUT_SIZE, INPUT_SIZE):
                raise RuntimeError("DINOv2 prepared input dimensions differ from the pinned contract")
            values = np.asarray(image, dtype=np.float32) / 255.0
            arrays.append(torch.from_numpy(values).permute(2, 0, 1))
        batch = torch.stack(arrays).to(self._device)
        mean = torch.tensor((0.485, 0.456, 0.406), device=self._device).view(1, 3, 1, 1)
        std = torch.tensor((0.229, 0.224, 0.225), device=self._device).view(1, 3, 1, 1)
        batch = (batch - mean) / std
        with torch.inference_mode(), self._autocast():
            outputs = self._model(pixel_values=batch)
            hidden = outputs.last_hidden_state
            global_features = torch.nn.functional.normalize(hidden[:, 0], dim=-1)
            patch_features = torch.nn.functional.normalize(hidden[:, 1:], dim=-1)
        if global_features.shape[1] != EMBEDDING_DIMENSIONS:
            raise RuntimeError("DINOv2 CLS dimensions differ from the pinned model")
        if patch_features.shape[1] != (INPUT_SIZE // PATCH_SIZE) ** 2:
            raise RuntimeError("DINOv2 patch count differs from the pinned input grid")
        globals_array = global_features.float().cpu().numpy()
        patches_array = patch_features.float().cpu().numpy()
        return [
            DinoEncodedView(
                globals_array[index],
                patches_array[index],
                _patch_salience(images[index]),
            )
            for index in range(len(images))
        ]


class DinoV2PairEngine:
    def __init__(
        self,
        backend: DinoBackend | None = None,
        cache_size: int = 256,
    ) -> None:
        if cache_size < 8:
            raise ValueError("embedding cache size must be at least eight")
        self._backend = backend or DinoV2Backend()
        self._cache_size = cache_size
        self._cache: OrderedDict[str, DinoEncodedView] = OrderedDict()
        self._lock = threading.RLock()

    def health(self) -> tuple[str, str]:
        return self._backend.health()

    def _cache_key(self, image: Image.Image) -> str:
        return sha256(image.tobytes()).hexdigest()

    def _embeddings(
        self,
        images: Sequence[Image.Image],
    ) -> tuple[list[DinoEncodedView], int]:
        keys = [self._cache_key(image) for image in images]
        misses: OrderedDict[str, Image.Image] = OrderedDict()
        cache_hits = 0
        for key, image in zip(keys, images):
            if key in self._cache:
                self._cache.move_to_end(key)
                cache_hits += 1
            elif key in misses:
                cache_hits += 1
            else:
                misses[key] = image
        if misses:
            encoded = self._backend.encode(list(misses.values()))
            if len(encoded) != len(misses):
                raise RuntimeError("DINOv2 embedding count differs from the request")
            for key, embedding in zip(misses, encoded):
                self._cache[key] = embedding
                self._cache.move_to_end(key)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        return [self._cache[key] for key in keys], cache_hits

    def score_pair(self, reference: bytes, candidate: bytes) -> PairScore:
        started = time.perf_counter()
        reference_image = _decode_image(reference)
        candidate_image = _decode_image(candidate)
        reference_views = _prepared_views(reference_image)
        candidate_views = _prepared_views(candidate_image)
        with self._lock:
            embeddings, cache_hits = self._embeddings(reference_views + candidate_views)
        scores = []
        for index, view_name in enumerate(VIEW_NAMES):
            metrics = compare_feature_sets(embeddings[index], embeddings[index + len(VIEW_NAMES)])
            scores.append(RegionalPairScore(
                view=view_name,
                identity_similarity=metrics.identity_similarity,
                patch_correspondence=metrics.patch_correspondence,
                critical_patch_retention=metrics.critical_patch_retention,
                regional_coverage=metrics.regional_coverage,
                confidence=metrics.confidence,
            ))
        confidence = float(np.mean([score.confidence for score in scores]))
        return PairScore(
            views=tuple(scores),
            confidence=confidence,
            inference_ms=(time.perf_counter() - started) * 1000,
            cache_hits=cache_hits,
        )
