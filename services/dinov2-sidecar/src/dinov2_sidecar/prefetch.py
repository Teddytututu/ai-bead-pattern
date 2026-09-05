from huggingface_hub import snapshot_download

from .contracts import MODEL_REPOSITORY, WEIGHT_REVISION


def main() -> None:
    path = snapshot_download(
        repo_id=MODEL_REPOSITORY,
        revision=WEIGHT_REVISION,
        allow_patterns=("config.json", "model.safetensors"),
    )
    print(f"Pinned DINOv2 assets ready: {path}")


if __name__ == "__main__":
    main()
