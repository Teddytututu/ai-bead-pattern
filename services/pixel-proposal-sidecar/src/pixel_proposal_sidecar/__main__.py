import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "pixel_proposal_sidecar.app:app",
        host="127.0.0.1",
        port=int(os.environ.get("PIXEL_PROPOSAL_PORT", "7101")),
        workers=1,
        log_level=os.environ.get("PIXEL_PROPOSAL_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
