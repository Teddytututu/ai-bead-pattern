from __future__ import annotations

from typing import Tuple

import cv2
import numpy as np

MODEL_INPUT_SIZE = (256, 256)
NORMALIZATION_MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
NORMALIZATION_STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)


def bbox_xyxy_to_center_scale(
    bbox: np.ndarray,
    padding: float = 1.25,
) -> tuple[np.ndarray, np.ndarray]:
    left, top, right, bottom = (float(value) for value in bbox)
    center = np.array([(left + right) * 0.5, (top + bottom) * 0.5], dtype=np.float32)
    scale = np.array([right - left, bottom - top], dtype=np.float32) * padding
    return center, scale


def fix_aspect_ratio(scale: np.ndarray, aspect_ratio: float) -> np.ndarray:
    width, height = (float(value) for value in scale)
    if width > height * aspect_ratio:
        height = width / aspect_ratio
    else:
        width = height * aspect_ratio
    return np.array([width, height], dtype=np.float32)


def _rotate_point(point: np.ndarray, angle_rad: float) -> np.ndarray:
    sine, cosine = np.sin(angle_rad), np.cos(angle_rad)
    return np.array([[cosine, -sine], [sine, cosine]], dtype=np.float32) @ point


def _third_point(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    direction = first - second
    return second + np.array([-direction[1], direction[0]], dtype=np.float32)


def warp_matrix(
    center: np.ndarray,
    scale: np.ndarray,
    output_size: Tuple[int, int],
) -> np.ndarray:
    destination_width, destination_height = output_size
    source_direction = _rotate_point(
        np.array([0.0, float(scale[0]) * -0.5], dtype=np.float32),
        0.0,
    )
    destination_direction = np.array([0.0, destination_width * -0.5], dtype=np.float32)
    source = np.zeros((3, 2), dtype=np.float32)
    source[0] = center
    source[1] = center + source_direction
    source[2] = _third_point(source[0], source[1])
    destination = np.zeros((3, 2), dtype=np.float32)
    destination[0] = [destination_width * 0.5, destination_height * 0.5]
    destination[1] = destination[0] + destination_direction
    destination[2] = _third_point(destination[0], destination[1])
    return cv2.getAffineTransform(source, destination)


def preprocess_instance(
    image: np.ndarray,
    bbox: tuple[float, float, float, float],
    input_size: Tuple[int, int] = MODEL_INPUT_SIZE,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("RTMPose input must use RGB channels")
    if image.shape[0] < 2 or image.shape[1] < 2:
        raise ValueError("RTMPose input dimensions are too small")
    left, top, right, bottom = bbox
    if left < 0 or top < 0 or right <= left or bottom <= top:
        raise ValueError("RTMPose bbox is invalid")
    center, scale = bbox_xyxy_to_center_scale(
        np.array([left, top, right, bottom], dtype=np.float32),
    )
    scale = fix_aspect_ratio(scale, input_size[0] / input_size[1])
    affine = warp_matrix(center, scale, input_size)
    resized = cv2.warpAffine(
        image,
        affine,
        (int(input_size[0]), int(input_size[1])),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    ).astype(np.float32)
    normalized = (resized - NORMALIZATION_MEAN) / NORMALIZATION_STD
    tensor = normalized.transpose(2, 0, 1)[None, :, :, :].astype(np.float32)
    return tensor, center, scale


def simcc_maximum(simcc_x: np.ndarray, simcc_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if simcc_x.ndim != 3 or simcc_y.ndim != 3 or simcc_x.shape[:2] != simcc_y.shape[:2]:
        raise ValueError("SimCC output shapes are invalid")
    instance_count, keypoint_count, _ = simcc_x.shape
    flat_x = simcc_x.reshape(instance_count * keypoint_count, -1)
    flat_y = simcc_y.reshape(instance_count * keypoint_count, -1)
    x_locations = np.argmax(flat_x, axis=1)
    y_locations = np.argmax(flat_y, axis=1)
    locations = np.stack((x_locations, y_locations), axis=-1).astype(np.float32)
    scores = np.minimum(np.amax(flat_x, axis=1), np.amax(flat_y, axis=1))
    locations[scores <= 0.0] = -1.0
    return (
        locations.reshape(instance_count, keypoint_count, 2),
        scores.reshape(instance_count, keypoint_count),
    )


def decode_simcc(
    simcc_x: np.ndarray,
    simcc_y: np.ndarray,
    model_input_size: Tuple[int, int],
    center: np.ndarray,
    scale: np.ndarray,
    split_ratio: float = 2.0,
) -> tuple[np.ndarray, np.ndarray]:
    keypoints, scores = simcc_maximum(simcc_x, simcc_y)
    keypoints /= split_ratio
    input_array = np.array(model_input_size, dtype=np.float32)
    center_array = np.asarray(center, dtype=np.float32)
    scale_array = np.asarray(scale, dtype=np.float32)
    if center_array.ndim == 1:
        center_array = center_array[None, :]
    if scale_array.ndim == 1:
        scale_array = scale_array[None, :]
    if center_array.shape != (keypoints.shape[0], 2) or scale_array.shape != center_array.shape:
        raise ValueError("RTMPose centers and scales must match the instance batch")
    keypoints = (
        keypoints / input_array * scale_array[:, None, :]
        + center_array[:, None, :]
        - scale_array[:, None, :] / 2.0
    )
    return keypoints.astype(np.float32), np.clip(scores, 0.0, 1.0).astype(np.float32)
