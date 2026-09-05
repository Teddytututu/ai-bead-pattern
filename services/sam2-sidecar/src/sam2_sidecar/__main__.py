import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "sam2_sidecar.app:app",
        host=os.environ.get("SAM2_HOST", "127.0.0.1"),
        port=int(os.environ.get("SAM2_PORT", "7103")),
        workers=1,
    )


if __name__ == "__main__":
    main()
