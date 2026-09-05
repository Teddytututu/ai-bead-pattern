import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "openclip_sidecar.app:app",
        host="127.0.0.1",
        port=int(os.environ.get("OPENCLIP_PORT", "7102")),
        workers=1,
        log_level=os.environ.get("OPENCLIP_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
