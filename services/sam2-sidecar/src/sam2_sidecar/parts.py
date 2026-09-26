"""Adapter for Grounded-SAM-2's detector-box -> SAM mask inference flow.

Sources: IDEA-Research/Grounded-SAM-2/grounded_sam2_hf_model_demo.py;
OpenCV moments/minAreaRect. No hand-painted masks or custom part scoring.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from .engine import MASK_THRESHOLD, SegmentationResult, _mask_crop

PART_LABELS = ("eye", "nose", "mouth", "head", "ear", "torso", "leg", "tail", "hair", "skin", "clothes", "arm", "hand")


def part_kind(label: str) -> str | None:
    value = label.strip().lower().rstrip(".")
    return value if value in PART_LABELS else None


def segment_parts(image, batch, detector, backend):
    parts = []
    warnings = []
    elapsed = batch.inference_ms
    for subject in batch.instances[:8]:
        x, y, width, height = subject.crop
        crop = image.crop((x, y, x + width, y + height))
        detected = detector.detect(crop, PART_LABELS)
        elapsed += detected.inference_ms
        detections = tuple(
            replace(item, label=kind) for item in detected.detections
            if (kind := part_kind(item.label)) is not None
        )
        if not detections:
            warnings.append(f"{subject.instance_id}: no neural part detections; no inferred masks added")
            continue
        prediction = backend.segment_boxes(crop, tuple(item.box for item in detections))
        elapsed += prediction.inference_ms
        masks = np.asarray(prediction.masks, dtype=np.float32)
        ious = np.asarray(prediction.predicted_ious, dtype=np.float32).reshape(-1)
        if masks.shape != (len(detections), height, width) or len(ious) != len(detections):
            raise RuntimeError("Neural part mask dimensions differ from the crop")
        if not np.isfinite(masks).all() or not np.isfinite(ious).all():
            raise RuntimeError("Neural part masks contain non-finite values")
        counts = {}
        for detection, probabilities, iou in zip(detections, masks, ious):
            local = probabilities >= MASK_THRESHOLD
            if not local.any():
                continue
            counts[detection.label] = counts.get(detection.label, 0) + 1
            mask = np.zeros(batch.subject_mask.shape, dtype=np.bool_)
            mask[y:y + height, x:x + width] = local
            parts.append(SegmentationResult(
                mask=mask, importance_map=mask.astype(np.float32), confidence=detection.score,
                predicted_iou=float(np.clip(iou, 0, 1)), stability_score=0.0,
                prompt_agreement=1.0, lasso_containment=1.0, crop=_mask_crop(mask),
                instance_id=f"{subject.instance_id}:{detection.label}-{counts[detection.label]:02d}",
                label=detection.label, prompt_source="neural-detection+sam2",
                positive_point_count=0, negative_point_count=0, mask_area_ratio=float(mask.mean()),
                inference_ms=prediction.inference_ms, device=prediction.device,
                detection_box=tuple(value + (x if index % 2 == 0 else y) for index, value in enumerate(detection.box)),
                detection_score=detection.score,
            ))
        missing = [kind for kind in ("head", "eye", "nose", "mouth") if counts.get(kind, 0) == 0]
        if missing:
            warnings.append(f"{subject.instance_id}: neural masks unavailable for {', '.join(missing)}")
    if len(batch.instances) > 8:
        warnings.append("Neural part analysis limited to eight subjects; remaining subjects have no part masks")
    return replace(batch, parts=select_part_instances(parts), warnings=tuple(warnings), inference_ms=elapsed)


def select_part_instances(parts):
    """Use upstream connected components and class-aware NMS for duplicate outputs.

    An 'eye' detection can cover both eyes; splitting its actual foreground
    components does not invent a second eye or change any mask pixel.
    """
    import cv2
    import torch
    from torchvision.ops import batched_nms, masks_to_boxes

    candidates = []
    for part in parts:
        if part.label != 'eye':
            candidates.append(part)
            continue
        count, labels = cv2.connectedComponents(part.mask.astype(np.uint8), connectivity=8)
        for label in range(1, count):
            mask = labels == label
            candidates.append(replace(part, mask=mask, crop=_mask_crop(mask)))
    if not candidates:
        return ()
    groups = [(part.instance_id.split(':', 1)[0], part.label) for part in candidates]
    group_ids = {group: index for index, group in enumerate(sorted(set(groups)))}
    boxes = masks_to_boxes(torch.from_numpy(np.stack([part.mask for part in candidates])))
    keep = batched_nms(boxes, torch.tensor([part.confidence for part in candidates]),
                       torch.tensor([group_ids[group] for group in groups]), iou_threshold=0.5).tolist()
    counts = {}
    selected = []
    for index in keep:
        part = candidates[index]
        subject_id, kind = groups[index]
        key = (subject_id, kind)
        counts[key] = counts.get(key, 0) + 1
        selected.append(replace(part, instance_id=f'{subject_id}:{kind}-{counts[key]:02d}'))
    return tuple(selected)


def part_landmark(part, provenance):
    """Measure each independent network mask, including tilted/asymmetric eyes."""
    import cv2

    if part.label not in ("eye", "nose", "mouth"):
        return None
    binary = part.mask.astype(np.uint8)
    moments = cv2.moments(binary, binaryImage=True)
    if moments["m00"] == 0:
        return None
    x, y = moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]
    _center, (width, height), angle = cv2.minAreaRect(cv2.findNonZero(binary))
    if width < height:
        width, height, angle = height, width, angle + 90
    angle = (angle + 90) % 180 - 90
    width, height = width + 1, height + 1  # pixel centers -> pixel extents
    subject_id = part.instance_id.split(":", 1)[0]
    return {
        "id": part.instance_id, "kind": part.label, "x": x, "y": y,
        "confidence": part.confidence, "priority": "hard", "observationState": "observed",
        "instanceId": subject_id, "featureGroupId": subject_id,
        "featureRegionId": part.instance_id, "carrierRegionId": f"{subject_id}:subject",
        "sourceRadiusPx": max(width, height) / 2,
        "featureShape": {"widthPx": width, "heightPx": height, "angleDegrees": angle},
        "provenance": provenance,
    }
