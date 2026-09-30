from pathlib import Path
import hashlib
import os

MODEL_ID = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
MODEL_REVISION = "115134f363124c53c7d878647567d04daf26e41e"
ROOT = Path(__file__).resolve().parents[4]
MODEL_PATH = ROOT / ".tools/huggingface/pinned/sdxl-inpainting" / MODEL_REVISION
SCHEMA = "region-generation-v3"


def configure_environment():
    os.environ.setdefault("HF_HOME", str(ROOT / ".tools/huggingface"))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def sha256_file(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
