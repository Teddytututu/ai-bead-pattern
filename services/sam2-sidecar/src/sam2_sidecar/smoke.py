from __future__ import annotations

import io
import json

from PIL import Image, ImageDraw

from .contracts import InstancePrompt, SegmentationRequest
from .engine import Sam2SegmentationEngine


def synthetic_subject() -> bytes:
    image = Image.new("RGB", (256, 192), (245, 245, 245))
    drawing = ImageDraw.Draw(image)
    drawing.ellipse((60, 28, 196, 164), fill=(80, 120, 180))
    drawing.polygon(((72, 52), (82, 8), (110, 42)), fill=(80, 120, 180))
    drawing.polygon(((146, 42), (178, 8), (186, 56)), fill=(80, 120, 180))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> None:
    engine = Sam2SegmentationEngine()
    result = engine.segment(
        synthetic_subject(),
        SegmentationRequest(
            capabilities=("subject-segmentation", "edge-thin-structure"),
            image_type_hint="pet",
            prompt=InstancePrompt(
                lasso=((0.2, 0.03), (0.8, 0.03), (0.82, 0.9), (0.18, 0.9)),
                positive_points=((0.5, 0.5),),
                negative_points=((0.04, 0.5), (0.96, 0.5)),
                labels=("cat",),
                selected_instance_id="synthetic-cat",
            ),
            source_id="sam2-smoke",
        ),
    )
    print(json.dumps({
        "instanceId": result.instance_id,
        "predictedIoU": round(result.predicted_iou, 4),
        "stabilityScore": round(result.stability_score, 4),
        "promptAgreement": round(result.prompt_agreement, 4),
        "lassoContainment": round(result.lasso_containment, 4),
        "maskAreaRatio": round(result.mask_area_ratio, 4),
        "crop": result.crop,
        "device": result.device,
        "inferenceMs": round(result.inference_ms, 1),
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
