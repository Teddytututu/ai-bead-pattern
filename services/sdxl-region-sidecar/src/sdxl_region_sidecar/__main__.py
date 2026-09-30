import os
import uvicorn

if __name__ == "__main__":
    uvicorn.run("sdxl_region_sidecar.app:app", host="127.0.0.1", port=int(os.environ.get("SDXL_REGION_PORT", "7117")), workers=1)
