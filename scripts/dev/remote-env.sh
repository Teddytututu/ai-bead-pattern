#!/usr/bin/env bash
# Source from Bash; all installed tools and caches belong to this checkout.
IMAGE_PINDOU_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export IMAGE_PINDOU_ROOT
export PATH="$IMAGE_PINDOU_ROOT/.tools/runtime/node-v24.13.0-linux-x64/bin:$IMAGE_PINDOU_ROOT/.tools/pnpm/node_modules/.bin:$IMAGE_PINDOU_ROOT/.tools/bootstrap/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$IMAGE_PINDOU_ROOT/.tools/python"
export UV_CACHE_DIR="$IMAGE_PINDOU_ROOT/.tools/cache/uv"
export UV_LINK_MODE=hardlink
export HF_HOME="$IMAGE_PINDOU_ROOT/.tools/huggingface"
export HF_HUB_DISABLE_XET=1
export TOKENIZERS_PARALLELISM=false
export PLAYWRIGHT_BROWSERS_PATH="$IMAGE_PINDOU_ROOT/.tools/playwright"
export npm_config_store_dir="$IMAGE_PINDOU_ROOT/.tools/pnpm-store"
export npm_config_virtual_store_dir="$IMAGE_PINDOU_ROOT/.tools/pnpm-virtual-store"
# Shared machines: keep ordinary CPU work bounded. Select a GPU explicitly when
# launching GPU services; this file does not reserve or choose a shared GPU.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-4}"
