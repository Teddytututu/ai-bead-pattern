from __future__ import annotations

import hashlib
import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def write_json(path: Path, data) -> None:
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open('x', encoding='utf-8') as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')


def within(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f'path escapes input root: {relative}')
    return path


def verify_run(run: Path, *, check_code: bool = True) -> dict:
    """Refuse mixed-version runs or edited source lists; corrections are separate."""
    for relative, expected in json.loads((run / 'meta' / 'artifact-hashes.json').read_text(encoding='utf-8')).items():
        path = within(run, relative)
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'frozen run artifact changed: {relative}')
    config = json.loads((run / 'meta' / 'run-config.json').read_text(encoding='utf-8'))
    for relative, expected in (config['codeSha256'].items() if check_code else []):
        path = within(PROJECT, relative)
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'code changed since prepare; create a new run: {relative}')
    return config
