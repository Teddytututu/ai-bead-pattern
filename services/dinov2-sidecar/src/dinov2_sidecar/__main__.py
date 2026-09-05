import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "dinov2_sidecar.app:app",
        host=os.environ.get("DINOV2_HOST", "127.0.0.1"),
        port=int(os.environ.get("DINOV2_PORT", "7105")),
        reload=False,
    )
