from __future__ import annotations

import io

from PIL import Image, ImageDraw

from .engine import DinoV2PairEngine


def _sample(accent: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (168, 112), (245, 245, 245))
    draw = ImageDraw.Draw(image)
    draw.ellipse((38, 18, 130, 104), fill=accent)
    draw.polygon(((52, 30), (68, 4), (78, 34)), fill=accent)
    draw.polygon(((90, 34), (102, 4), (118, 30)), fill=accent)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> None:
    engine = DinoV2PairEngine()
    source = _sample((180, 110, 60))
    matching = engine.score_pair(source, source)
    changed = engine.score_pair(source, _sample((55, 110, 185)))
    print({
        "matchingIdentity": matching.identity_similarity,
        "changedIdentity": changed.identity_similarity,
        "matchingCriticalRetention": matching.critical_patch_retention,
        "changedCriticalRetention": changed.critical_patch_retention,
        "inferenceMs": matching.inference_ms,
    })


if __name__ == "__main__":
    main()
