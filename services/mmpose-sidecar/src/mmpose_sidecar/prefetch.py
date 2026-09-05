from __future__ import annotations

import hashlib
import shutil
import urllib.request
import zipfile
from pathlib import Path

from .contracts import WEIGHT_ARCHIVE_SHA256, WEIGHT_ONNX_SHA256, WEIGHT_URL
from .engine import repository_root

ARCHIVE_NAME = "rtmpose-m-ap10k-7a041aa1.zip"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive: Path, destination: Path) -> None:
    destination_root = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            target = (destination / entry.filename).resolve()
            if destination_root not in target.parents and target != destination_root:
                raise RuntimeError("RTMPose archive contains an unsafe path")
        source.extractall(destination)


def prefetch() -> Path:
    model_root = repository_root() / "work" / "models" / "rtmpose"
    archive = model_root / ARCHIVE_NAME
    extracted = model_root / "extracted"
    model_root.mkdir(parents=True, exist_ok=True)
    if not archive.is_file() or sha256(archive) != WEIGHT_ARCHIVE_SHA256:
        temporary = archive.with_suffix(".download")
        with urllib.request.urlopen(WEIGHT_URL, timeout=120) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if sha256(temporary) != WEIGHT_ARCHIVE_SHA256:
            raise RuntimeError("RTMPose archive checksum differs from the pinned release")
        temporary.replace(archive)
    matches = sorted(extracted.glob("**/end2end.onnx"))
    if len(matches) == 1 and sha256(matches[0]) == WEIGHT_ONNX_SHA256:
        return matches[0]
    extracted.mkdir(parents=True, exist_ok=True)
    safe_extract(archive, extracted)
    matches = sorted(extracted.glob("**/end2end.onnx"))
    if len(matches) != 1:
        raise RuntimeError("RTMPose archive layout differs from the pinned release")
    if sha256(matches[0]) != WEIGHT_ONNX_SHA256:
        raise RuntimeError("RTMPose ONNX checksum differs from the pinned release")
    return matches[0]


def main() -> None:
    print(prefetch())


if __name__ == "__main__":
    main()
