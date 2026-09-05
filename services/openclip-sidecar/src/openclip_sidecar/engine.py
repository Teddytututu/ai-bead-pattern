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
from typing import Protocol, Sequence

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .contracts import (
    EMBEDDING_DIMENSIONS,
    MODEL_NAME,
    PRETRAINED_TAG,
    WEIGHT_FILENAME,
    WEIGHT_REPOSITORY,
    WEIGHT_REVISION,
)

INPUT_SIZE = 224
MAXIMUM_DIMENSION = 4096
MAXIMUM_PIXELS = 16_000_000

CLASS_LABELS = (
    "cat",
    "dog",
    "rabbit",
    "bird",
    "person",
    "vehicle",
    "building",
    "landscape",
)
PROMPT_TEMPLATES = (
    "a photo of a {label}",
    "pixel art of a {label}",
    "an image of a {label}",
)
CLASS_PROMPTS = tuple(
    template.format(label=label)
    for label in CLASS_LABELS
    for template in PROMPT_TEMPLATES
)
PET_INDICES = tuple(CLASS_LABELS.index(label) for label in ("cat", "dog", "rabbit"))
BIRD_INDEX = CLASS_LABELS.index("bird")


class EmbeddingBackend(Protocol):
    def health(self) -> tuple[str, str]: ...

    def encode_images(self, images: list[Image.Image]) -> np.ndarray: ...

    def encode_texts(self, prompts: tuple[str, ...]) -> np.ndarray: ...

    @property
    def logit_scale(self) -> float: ...


@dataclass(frozen=True)
class PairScore:
    semantic_retention: float
    class_distribution_retention: float
    pet_bird_margin: float
    confidence: float
    inference_ms: float
    cache_hits: int


def prepare_image(source: bytes) -> Image.Image:
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
                raise ValueError("uploaded image dimensions exceed the OpenCLIP input limit")
            oriented = ImageOps.exif_transpose(opened).convert("RGBA")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP") from error

    opaque = Image.alpha_composite(
        Image.new("RGBA", oriented.size, (255, 255, 255, 255)),
        oriented,
    ).convert("RGB")
    fitted = ImageOps.contain(
        opaque,
        (INPUT_SIZE, INPUT_SIZE),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE), (255, 255, 255))
    canvas.paste(
        fitted,
        ((INPUT_SIZE - fitted.width) // 2, (INPUT_SIZE - fitted.height) // 2),
    )
    return canvas


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


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.max(values)
    exponentials = np.exp(shifted)
    return exponentials / np.sum(exponentials)


def _distribution_retention(first: np.ndarray, second: np.ndarray) -> float:
    midpoint = (first + second) * 0.5
    epsilon = 1e-12
    first_kl = np.sum(first * np.log((first + epsilon) / (midpoint + epsilon)))
    second_kl = np.sum(second * np.log((second + epsilon) / (midpoint + epsilon)))
    divergence = 0.5 * (first_kl + second_kl)
    return float(np.clip(1.0 - divergence / np.log(2.0), 0.0, 1.0))


def _source_distribution_confidence(distribution: np.ndarray) -> float:
    epsilon = 1e-12
    entropy = -np.sum(distribution * np.log(distribution + epsilon))
    maximum_entropy = np.log(float(distribution.shape[0]))
    entropy_certainty = 1.0 - entropy / maximum_entropy
    peak_certainty = float(np.max(distribution))
    return float(np.clip(0.5 * entropy_certainty + 0.5 * peak_certainty, 0.0, 1.0))


class OpenClipBackend:
    def __init__(
        self,
        device: str | None = None,
        cache_dir: str | Path | None = None,
    ) -> None:
        self._requested_device = device
        self._cache_dir = None if cache_dir is None else str(cache_dir)
        self._model = None
        self._preprocess = None
        self._tokenizer = None
        self._device = None
        self._load_lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            try:
                import open_clip
                import torch
                from huggingface_hub import hf_hub_download

                os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
                requested = self._requested_device or os.environ.get("OPENCLIP_DEVICE")
                device = requested or ("cuda" if torch.cuda.is_available() else "cpu")
                precision = os.environ.get("OPENCLIP_PRECISION", "fp32")
                if device.startswith("cuda"):
                    torch.set_float32_matmul_precision("highest")
                    torch.backends.cuda.matmul.allow_tf32 = False
                    torch.backends.cudnn.allow_tf32 = False
                    torch.backends.cudnn.benchmark = False
                    torch.backends.cudnn.deterministic = True
                weights_path = hf_hub_download(
                    repo_id=WEIGHT_REPOSITORY,
                    filename=WEIGHT_FILENAME,
                    revision=WEIGHT_REVISION,
                    cache_dir=self._cache_dir,
                )
                pretrained = open_clip.get_pretrained_cfg(MODEL_NAME, PRETRAINED_TAG)
                model, _training_transform, preprocess = open_clip.create_model_and_transforms(
                    MODEL_NAME,
                    pretrained=weights_path,
                    precision=precision,
                    device=device,
                    force_image_size=INPUT_SIZE,
                    image_mean=tuple(pretrained["mean"]),
                    image_std=tuple(pretrained["std"]),
                    image_interpolation=pretrained["interpolation"],
                    image_resize_mode=pretrained["resize_mode"],
                )
                model.eval()
                self._model = model
                self._preprocess = preprocess
                self._tokenizer = open_clip.get_tokenizer(MODEL_NAME)
                self._device = torch.device(device)
            except Exception as error:
                detail = " ".join(str(error).split())[:500]
                raise RuntimeError(f"OpenCLIP model load failed: {detail}") from error

    def health(self) -> tuple[str, str]:
        try:
            import open_clip
            import torch
        except Exception as error:
            return "unavailable", f"runtime import failed: {error}"
        if self._model is None:
            device = self._requested_device or os.environ.get("OPENCLIP_DEVICE")
            selected = device or ("cuda" if torch.cuda.is_available() else "cpu")
            return "degraded", (
                f"open_clip {open_clip.__version__} ready; pinned weights load on first request; "
                f"device={selected}"
            )
        return "ready", f"OpenCLIP ready; device={self._device}"

    def _autocast(self):
        assert self._device is not None
        if self._device.type == "cuda":
            import torch

            return torch.autocast(device_type="cuda", dtype=torch.float16)
        return nullcontext()

    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._preprocess is not None
        assert self._device is not None
        batch = torch.stack([self._preprocess(image) for image in images]).to(self._device)
        with torch.inference_mode(), self._autocast():
            features = self._model.encode_image(batch)
            features = features / features.norm(dim=-1, keepdim=True)
        result = features.float().cpu().numpy()
        if result.shape[1] != EMBEDDING_DIMENSIONS:
            raise RuntimeError("OpenCLIP image embedding dimensions differ from the pinned model")
        return result

    def encode_texts(self, prompts: tuple[str, ...]) -> np.ndarray:
        self._ensure_loaded()
        import torch

        assert self._model is not None
        assert self._tokenizer is not None
        assert self._device is not None
        tokens = self._tokenizer(list(prompts)).to(self._device)
        with torch.inference_mode(), self._autocast():
            features = self._model.encode_text(tokens)
            features = features / features.norm(dim=-1, keepdim=True)
        result = features.float().cpu().numpy()
        if result.shape[1] != EMBEDDING_DIMENSIONS:
            raise RuntimeError("OpenCLIP text embedding dimensions differ from the pinned model")
        return result

    @property
    def logit_scale(self) -> float:
        self._ensure_loaded()
        assert self._model is not None
        return float(self._model.logit_scale.exp().detach().float().cpu().item())


class OpenClipPairEngine:
    class_prompts = CLASS_PROMPTS

    def __init__(
        self,
        backend: EmbeddingBackend | None = None,
        cache_size: int = 128,
    ) -> None:
        if cache_size < 2:
            raise ValueError("embedding cache size must be at least two")
        self._backend = backend or OpenClipBackend()
        self._cache_size = cache_size
        self._image_cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._text_embeddings: np.ndarray | None = None
        self._lock = threading.RLock()

    def health(self) -> tuple[str, str]:
        return self._backend.health()

    def _cache_key(self, image: Image.Image) -> str:
        return sha256(image.tobytes()).hexdigest()

    def _pair_embeddings(
        self,
        images: Sequence[Image.Image],
    ) -> tuple[list[np.ndarray], int]:
        keys = [self._cache_key(image) for image in images]
        misses: OrderedDict[str, Image.Image] = OrderedDict()
        cache_hits = 0
        for key, image in zip(keys, images):
            if key in self._image_cache:
                self._image_cache.move_to_end(key)
                cache_hits += 1
            elif key not in misses:
                misses[key] = image
        if misses:
            encoded = _normalized_rows(
                self._backend.encode_images(list(misses.values())),
                "OpenCLIP image embeddings",
            )
            if encoded.shape[0] != len(misses):
                raise RuntimeError("OpenCLIP image embedding count differs from the request")
            for key, embedding in zip(misses, encoded):
                self._image_cache[key] = embedding
                self._image_cache.move_to_end(key)
                while len(self._image_cache) > self._cache_size:
                    self._image_cache.popitem(last=False)
        return [self._image_cache[key] for key in keys], cache_hits

    def _class_embeddings(self) -> np.ndarray:
        if self._text_embeddings is None:
            prompt_embeddings = _normalized_rows(
                self._backend.encode_texts(CLASS_PROMPTS),
                "OpenCLIP text embeddings",
            )
            if prompt_embeddings.shape[0] != len(CLASS_PROMPTS):
                raise RuntimeError("OpenCLIP text embedding count differs from the prompt catalog")
            grouped = prompt_embeddings.reshape(
                len(CLASS_LABELS),
                len(PROMPT_TEMPLATES),
                prompt_embeddings.shape[1],
            ).mean(axis=1)
            self._text_embeddings = _normalized_rows(
                grouped,
                "OpenCLIP class prototype embeddings",
            )
        return self._text_embeddings

    def score_pair(self, reference: bytes, candidate: bytes) -> PairScore:
        started = time.perf_counter()
        reference_image = prepare_image(reference)
        candidate_image = prepare_image(candidate)
        with self._lock:
            image_embeddings, cache_hits = self._pair_embeddings((reference_image, candidate_image))
            text_embeddings = self._class_embeddings()
            scale = float(np.clip(self._backend.logit_scale, 1.0, 100.0))

        reference_embedding, candidate_embedding = image_embeddings
        if reference_embedding.shape != candidate_embedding.shape:
            raise RuntimeError("OpenCLIP pair embeddings use different dimensions")
        if reference_embedding.shape[0] != text_embeddings.shape[1]:
            raise RuntimeError("OpenCLIP image and text embedding dimensions differ")

        semantic_retention = float(np.clip(
            np.dot(reference_embedding, candidate_embedding),
            0.0,
            1.0,
        ))
        reference_distribution = _softmax(scale * (text_embeddings @ reference_embedding))
        candidate_distribution = _softmax(scale * (text_embeddings @ candidate_embedding))
        class_distribution_retention = _distribution_retention(
            reference_distribution,
            candidate_distribution,
        )
        source_pet_probabilities = reference_distribution[list(PET_INDICES)]
        source_pet_index = PET_INDICES[int(np.argmax(source_pet_probabilities))]
        pet_bird_margin = float(
            candidate_distribution[source_pet_index]
            - candidate_distribution[BIRD_INDEX]
        )
        confidence = _source_distribution_confidence(reference_distribution)
        elapsed_ms = (time.perf_counter() - started) * 1000
        return PairScore(
            semantic_retention=semantic_retention,
            class_distribution_retention=class_distribution_retention,
            pet_bird_margin=pet_bird_margin,
            confidence=confidence,
            inference_ms=elapsed_ms,
            cache_hits=cache_hits,
        )
