"""Explicit pinned download. Inference never downloads models implicitly."""
import json
from .model import MODEL_ID, MODEL_REVISION, MODEL_PATH, configure_environment, sha256_file


def main():
    configure_environment()
    from huggingface_hub import snapshot_download
    snapshot_download(
        MODEL_ID, revision=MODEL_REVISION, local_dir=MODEL_PATH,
        allow_patterns=["*.json", "*.txt", "*.fp16.safetensors", "README.md"],
        max_workers=2,
    )
    files = sorted(p for p in MODEL_PATH.rglob("*") if p.is_file() and ".cache" not in p.parts and p.name != "local-manifest.json")
    manifest = {"model": MODEL_ID, "revision": MODEL_REVISION,
                "license": "CreativeML Open RAIL++-M", "files": [
        {"path": p.relative_to(MODEL_PATH).as_posix(), "bytes": p.stat().st_size, "sha256": sha256_file(p)} for p in files]}
    (MODEL_PATH / "local-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"path": str(MODEL_PATH), "files": len(files), "bytes": sum(f["bytes"] for f in manifest["files"])}), flush=True)


if __name__ == "__main__":
    main()
