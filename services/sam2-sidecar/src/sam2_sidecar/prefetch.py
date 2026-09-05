from __future__ import annotations

import os

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import snapshot_download

from .contracts import (
    GROUNDING_DINO_MODEL_REPOSITORY,
    GROUNDING_DINO_MODEL_REVISION,
    MODEL_REPOSITORY,
    MODEL_REVISION,
)

SAM2_REQUIRED_FILES = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "processor_config.json",
)

GROUNDING_DINO_REQUIRED_FILES = (
    "added_tokens.json",
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
)


def main() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    sam_path = snapshot_download(
        repo_id=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        allow_patterns=list(SAM2_REQUIRED_FILES),
    )
    grounding_path = snapshot_download(
        repo_id=GROUNDING_DINO_MODEL_REPOSITORY,
        revision=GROUNDING_DINO_MODEL_REVISION,
        allow_patterns=list(GROUNDING_DINO_REQUIRED_FILES),
    )
    print(f"SAM2 checkpoint ready: {sam_path}")
    print(f"GroundingDINO checkpoint ready: {grounding_path}")


if __name__ == "__main__":
    main()
