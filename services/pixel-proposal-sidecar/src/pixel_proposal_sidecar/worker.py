from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

from .contracts import ProposalRequest
from .engine import InProcessPixelPipeline, encode_raw_rgba


def write_result(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def main() -> None:
    source_path = Path(sys.argv[1])
    request_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    try:
        value = json.loads(request_path.read_text(encoding="utf-8"))
        request = ProposalRequest(
            kind=value["kind"],
            target_grid=tuple(value["targetGrid"]),
            palette_id=value.get("paletteId"),
            style_id=value.get("styleId"),
            prompt=value.get("prompt"),
            source_id=value.get("sourceId"),
        )
        proposal, elapsed_ms = InProcessPixelPipeline().generate_one(
            source_path.read_bytes(),
            request,
            int(value["seed"]),
        )
        write_result(output_path, {
            "id": proposal.proposal_id,
            "confidence": proposal.confidence,
            "seed": proposal.seed,
            "width": proposal.image.width,
            "height": proposal.image.height,
            "rgbaBase64": encode_raw_rgba(proposal.image),
            "sourceFrame": proposal.source_frame.to_wire(),
            "elapsedMs": elapsed_ms,
        })
        os._exit(0)
    except Exception as error:
        write_result(output_path, {
            "error": str(error),
            "traceback": traceback.format_exc(limit=8)[-4000:],
        })
        os._exit(1)


if __name__ == "__main__":
    main()
