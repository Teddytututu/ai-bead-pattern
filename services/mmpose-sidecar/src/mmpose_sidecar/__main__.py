from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "mmpose_sidecar.app:app",
        host=os.environ.get("MMPOSE_HOST", "127.0.0.1"),
        port=int(os.environ.get("MMPOSE_PORT", "7104")),
    )


if __name__ == "__main__":
    main()
