from __future__ import annotations

import io
import json
import os
from pathlib import Path

import httpx
from PIL import Image

from .contracts import InstancePrompt, SegmentationRequest
from .engine import Sam2SegmentationEngine

OFFICIAL_TWO_CATS_URL = (
    "https://raw.githubusercontent.com/IDEA-Research/GroundingDINO/"
    "856dde20aee659246248e20734ef9ba5214f5e44/.asset/cats.png"
)
MAXIMUM_SMOKE_BYTES = 16 * 1024 * 1024


def _source_image() -> tuple[bytes, str]:
    configured = os.environ.get("GROUNDED_SMOKE_IMAGE")
    if configured:
        path = Path(configured).expanduser().resolve()
        return path.read_bytes(), str(path)
    response = httpx.get(
        OFFICIAL_TWO_CATS_URL,
        follow_redirects=True,
        timeout=30,
        headers={"User-Agent": "ai-bead-pattern-smoke/1.0"},
    )
    response.raise_for_status()
    source = response.content
    if len(source) == 0 or len(source) > MAXIMUM_SMOKE_BYTES:
        raise RuntimeError("grounded smoke image exceeds the byte limit")
    return source, OFFICIAL_TWO_CATS_URL


def main() -> None:
    source, source_name = _source_image()
    with Image.open(io.BytesIO(source)) as image:
        source_size = image.size
    engine = Sam2SegmentationEngine()
    result = engine.analyze(
        source,
        SegmentationRequest(
            capabilities=("subject-segmentation", "edge-thin-structure"),
            image_type_hint="pet",
            prompt=InstancePrompt(labels=("a cat",)),
            source_id="coco-two-cats",
            automatic_detection=True,
        ),
    )
    cats = [
        instance
        for instance in result.instances
        if "cat" in (instance.label or "").lower()
    ]
    if len(cats) < 5:
        raise RuntimeError("grounded smoke requires five independently detected cats")
    if any(instance.mask.shape != (source_size[1], source_size[0]) for instance in result.instances):
        raise RuntimeError("grounded smoke masks differ from the source dimensions")
    print(json.dumps({
        "source": source_name,
        "sourceSize": source_size,
        "instanceCount": len(result.instances),
        "instances": [{
            "instanceId": instance.instance_id,
            "label": instance.label,
            "detectionScore": round(instance.detection_score or 0.0, 4),
            "predictedIoU": round(instance.predicted_iou, 4),
            "stabilityScore": round(instance.stability_score, 4),
            "maskPixels": int(instance.mask.sum()),
            "crop": instance.crop,
        } for instance in result.instances],
        "unionCrop": result.crop,
        "device": result.device,
        "detectorInferenceMs": round(result.detector_inference_ms, 1),
        "samInferenceMs": round(result.segmentation_inference_ms, 1),
        "inferenceMs": round(result.inference_ms, 1),
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
