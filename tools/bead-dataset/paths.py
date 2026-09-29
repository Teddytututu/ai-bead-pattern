"""Paths for the dated local collection, independent of the working directory."""
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
PROJECT = TOOLS.parents[1]
ROOT = PROJECT / 'output' / 'datasets' / 'bead-patterns-2026-09-29'
SNAPSHOT = TOOLS / 'snapshot'


def metadata_path(name):
    """Prefer local annotations; fall back to the versioned collection snapshot."""
    local = ROOT / name
    return local if local.exists() else SNAPSHOT / name
