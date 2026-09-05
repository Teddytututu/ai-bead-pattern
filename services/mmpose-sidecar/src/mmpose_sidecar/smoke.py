from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

from .contracts import PoseInstance, PoseRequest
from .engine import MMPoseEngine, repository_root
from .landmarks import landmarks_from_ap10k, pose_confidence


def main() -> None:
    root = repository_root()
    source_path = root / "apps" / "demo" / "assets" / "sample-cat.png"
    source = source_path.read_bytes()
    request = PoseRequest(
        instances=(PoseInstance("pet-01", (0.05, 0.04, 0.9, 0.9), "cat"),),
        source_id="sample-cat",
    )
    result = MMPoseEngine().analyze(source, request)
    landmarks = landmarks_from_ap10k(
        request.instance_id,
        result.keypoints[0:1],
        result.scores[0:1],
    )
    output_dir = root / "work" / "mmpose-smoke"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "sample-cat-keypoints.png"
    with Image.open(source_path) as uploaded:
        image = uploaded.convert("RGB")
    draw = ImageDraw.Draw(image)
    for landmark in landmarks:
        color = "#00e5ff" if landmark["observationState"] == "observed" else "#ffd166"
        x = float(landmark["x"])
        y = float(landmark["y"])
        radius = 7
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=color, width=3)
    image.save(output_path)
    print(json.dumps({
        "model": "open-mmlab/rtmpose-m-ap10k-onnx",
        "confidence": pose_confidence(result.scores),
        "inferenceMs": result.inference_ms,
        "observed": sum(1 for entry in landmarks if entry["observationState"] == "observed"),
        "output": str(output_path),
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
