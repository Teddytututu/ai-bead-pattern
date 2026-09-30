"""Bounded, offline smoke in a fresh process, using the existing pinned sidecar."""
from __future__ import annotations

import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from io_utils import PROJECT, digest, verify_run, write_json


def worker(image_path: Path, result_path: Path) -> None:
    os.environ.setdefault('HF_HOME', str(PROJECT / '.tools' / 'huggingface'))
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['SAM2_ALLOW_RUNTIME_DOWNLOAD'] = '0'
    from sam2_sidecar.contracts import (
        GROUNDED_MODEL_DESCRIPTOR, InstancePrompt, SegmentationRequest, checkpoint_directory,
        MODEL_REPOSITORY, MODEL_REVISION, GROUNDING_DINO_MODEL_REPOSITORY, GROUNDING_DINO_MODEL_REVISION,
    )
    from sam2_sidecar.engine import Sam2SegmentationEngine
    from PIL import Image
    import torch
    started = time.perf_counter()
    result = {
        'status': 'not-started', 'model': GROUNDED_MODEL_DESCRIPTOR,
        'packages': {name: importlib.metadata.version(name) for name in
                     ('torch', 'torchvision', 'transformers', 'numpy', 'opencv-python-headless', 'pillow', 'pydantic')},
        'cudaAvailable': torch.cuda.is_available(), 'python': sys.version,
        'image': str(image_path.resolve()), 'imageSha256': digest(image_path),
        'cache': [], 'transitions': ['not-started'],
    }
    phase = 'cache-unavailable'
    try:
        for repo, revision in ((MODEL_REPOSITORY, MODEL_REVISION), (GROUNDING_DINO_MODEL_REPOSITORY, GROUNDING_DINO_MODEL_REVISION)):
            directory = checkpoint_directory(repo, revision)
            files = sorted(p for p in directory.glob('*') if p.is_file())
            result['cache'].append({'repository': repo, 'revision': revision,
                'directory': str(directory), 'files': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in files}})
            if not (directory / 'model.safetensors').is_file():
                raise RuntimeError(f'pinned checkpoint missing: {repo}@{revision}')
        phase = 'runtime-unavailable'
        engine = Sam2SegmentationEngine()
        result['healthBefore'] = engine.grounded_health()
        if result['healthBefore'][0] == 'unavailable':
            raise RuntimeError(result['healthBefore'][1])
        result['transitions'].append('cold-loading')
        phase = 'inference-failed'
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        with Image.open(image_path) as image:
            size = image.size
        batch = engine.analyze(image_path.read_bytes(), SegmentationRequest(
            capabilities=('subject-segmentation', 'semantic-parsing', 'keypoints'),
            image_type_hint='pet', prompt=InstancePrompt(labels=('a cat',)),
            source_id='template-learning-runtime-smoke', automatic_detection=True,
        ))
        if not batch.instances or any(item.mask.shape != (size[1], size[0]) or not item.mask.any() for item in batch.instances):
            raise RuntimeError('smoke requires nonempty source-sized neural instance masks')
        result.update(status='ready', device=batch.device, healthAfter=engine.grounded_health(),
                      instanceCount=len(batch.instances), partCount=len(batch.parts),
                      partLabels=[p.label for p in batch.parts], warnings=list(batch.warnings),
                      modelInferenceMs=batch.inference_ms,
                      peakGpuBytes=torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None)
        result['transitions'].append('inference-succeeded')
    except Exception as error:
        if 'model load failed' in str(error):
            phase = 'cold-load-failed'
        result.update(status=phase, error=f'{type(error).__name__}: {error}')
        result['transitions'].append('failed')
    result['wallSeconds'] = time.perf_counter() - started
    result['qualityConclusion'] = 'runtime-only; not bead-sheet accuracy or warm latency'
    write_json(result_path, result)


def probe(run: Path, image: Path) -> dict:
    config_path = run / 'meta' / 'run-config.json'
    config = verify_run(run)
    destination = run / 'meta' / 'runtime.json'
    if destination.exists():
        raise FileExistsError('runtime already recorded; create a new run')
    worker_result = run / 'meta' / 'runtime-worker.json'
    if worker_result.exists():
        raise FileExistsError('incomplete worker record exists; preserve it and create a new run')
    with (run / 'meta' / 'runtime-stdout.log').open('x', encoding='utf-8') as out, (run / 'meta' / 'runtime-stderr.log').open('x', encoding='utf-8') as err:
        try:
            completed = subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')),
                '_runtime-worker', '--image', str(image.resolve()), '--output', str(worker_result.resolve())],
                stdout=out, stderr=err, timeout=config['budgets']['timeoutSeconds'], check=False)
            result = json.loads(worker_result.read_text(encoding='utf-8')) if worker_result.exists() else {
                'status': 'process-failed', 'exitCode': completed.returncode,
                'error': 'worker exited without a result; see runtime-stderr.log'}
            if completed.returncode:
                result['status'] = 'process-failed'
                result['exitCode'] = completed.returncode
        except subprocess.TimeoutExpired:
            result = {'status': 'timeout', 'timeoutSeconds': config['budgets']['timeoutSeconds']}
    result['runConfigSha256'] = digest(config_path)
    write_json(destination, result)
    return result
