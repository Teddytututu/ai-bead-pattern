from __future__ import annotations

import argparse
import json
from pathlib import Path

from .contracts import MODEL_DESCRIPTOR, PROVIDER_ID
from .engine import OpenClipBackend, OpenClipPairEngine


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the pinned OpenCLIP pair scorer")
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--candidate-id", default="smoke-candidate")
    parser.add_argument("--device", choices=("cpu", "cuda"))
    args = parser.parse_args()

    engine = OpenClipPairEngine(backend=OpenClipBackend(device=args.device))
    score = engine.score_pair(
        args.reference.read_bytes(),
        args.candidate.read_bytes(),
    )
    print(json.dumps({
        "providerId": PROVIDER_ID,
        "model": MODEL_DESCRIPTOR,
        "candidateId": args.candidate_id,
        "preferenceFeatures": {
            "semanticRetention": score.semantic_retention,
            "classDistributionRetention": score.class_distribution_retention,
            "petBirdMargin": score.pet_bird_margin,
        },
        "confidence": score.confidence,
        "inferenceMs": score.inference_ms,
        "embeddingCacheHits": score.cache_hits,
    }, indent=2))


if __name__ == "__main__":
    main()
