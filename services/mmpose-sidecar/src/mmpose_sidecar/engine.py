from __future__ import annotations

import io
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

from .contracts import PoseRequest
from .geometry import MODEL_INPUT_SIZE, decode_simcc, preprocess_instance


@dataclass(frozen=True)
class PoseResult:
    keypoints: np.ndarray
    scores: np.ndarray
    inference_ms: float
    device: str


def repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def default_model_path() -> Path:
    configured = os.environ.get("MMPOSE_MODEL_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    model_root = repository_root() / "work" / "models" / "rtmpose" / "extracted"
    matches = sorted(model_root.glob("**/end2end.onnx"))
    if len(matches) == 1:
        return matches[0]
    return model_root / "end2end.onnx"


def normalized_box_to_pixels(
    box: tuple[float, float, float, float],
    width: int,
    height: int,
) -> tuple[float, float, float, float]:
    x, y, box_width, box_height = box
    left = max(0.0, min(float(width - 1), x * width))
    top = max(0.0, min(float(height - 1), y * height))
    right = max(left + 1.0, min(float(width), (x + box_width) * width))
    bottom = max(top + 1.0, min(float(height), (y + box_height) * height))
    return (left, top, right, bottom)


class RtmposeEngine:
    def __init__(
        self,
        model_path: Path | None = None,
        session: Any | None = None,
        device: str | None = None,
    ) -> None:
        self.model_path = (model_path or default_model_path()).resolve()
        self._session: ort.InferenceSession | Any | None = session
        self.device = device or os.environ.get("MMPOSE_DEVICE", "cpu")
        self._inference_lock = threading.Lock()

    def _load_session(self) -> ort.InferenceSession:
        if self._session is not None:
            return self._session
        if not self.model_path.is_file():
            raise RuntimeError(
                "RTMPose model is missing; run pnpm mmpose:prefetch"
            )
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
        requested_provider = "CUDAExecutionProvider" if self.device.startswith("cuda") else "CPUExecutionProvider"
        if requested_provider not in ort.get_available_providers():
            requested_provider = "CPUExecutionProvider"
            self.device = "cpu"
        self._session = ort.InferenceSession(
            str(self.model_path),
            sess_options=options,
            providers=[requested_provider],
        )
        return self._session

    def health(self) -> tuple[str, str]:
        if self._session is not None:
            return "ready", f"RTMPose ONNX loaded; device={self.device}"
        if self.model_path.is_file():
            return "degraded", f"RTMPose ONNX loads on first request; device={self.device}"
        return "unavailable", "RTMPose model awaits pnpm mmpose:prefetch"

    def analyze(self, source: bytes, request: PoseRequest) -> PoseResult:
        try:
            with Image.open(io.BytesIO(source)) as uploaded:
                uploaded.load()
                image = ImageOps.exif_transpose(uploaded).convert("RGB")
        except (OSError, ValueError) as error:
            raise ValueError("uploaded image could not be decoded") from error
        if image.width < 2 or image.height < 2 or image.width > 4096 or image.height > 4096:
            raise ValueError("uploaded image dimensions are too small")
        array = np.asarray(image, dtype=np.uint8)
        tensors: list[np.ndarray] = []
        centers: list[np.ndarray] = []
        scales: list[np.ndarray] = []
        for instance in request.instances:
            bbox = normalized_box_to_pixels(instance.box, image.width, image.height)
            tensor, center, scale = preprocess_instance(array, bbox, MODEL_INPUT_SIZE)
            tensors.append(tensor)
            centers.append(center)
            scales.append(scale)
        tensor_batch = np.concatenate(tensors, axis=0)
        session = self._load_session()
        input_name = session.get_inputs()[0].name
        output_names = [output.name for output in session.get_outputs()]
        started = time.perf_counter()
        with self._inference_lock:
            outputs = session.run(output_names, {input_name: tensor_batch})
        inference_ms = (time.perf_counter() - started) * 1000.0
        if len(outputs) != 2:
            raise RuntimeError("RTMPose ONNX output count is invalid")
        keypoints, scores = decode_simcc(
            np.asarray(outputs[0]),
            np.asarray(outputs[1]),
            model_input_size=MODEL_INPUT_SIZE,
            center=np.stack(centers),
            scale=np.stack(scales),
        )
        instance_count = len(request.instances)
        if keypoints.shape != (instance_count, 17, 2) or scores.shape != (instance_count, 17):
            raise RuntimeError("RTMPose ONNX output shape is invalid")
        keypoints[:, :, 0] = np.clip(keypoints[:, :, 0], 0.0, image.width - 1.0)
        keypoints[:, :, 1] = np.clip(keypoints[:, :, 1], 0.0, image.height - 1.0)
        return PoseResult(
            keypoints=keypoints,
            scores=scores,
            inference_ms=inference_ms,
            device=self.device,
        )


MMPoseEngine = RtmposeEngine
