"""Pinned local OpenCLIP pair scorer."""

from .app import create_app
from .engine import OpenClipPairEngine

__all__ = ["OpenClipPairEngine", "create_app"]
