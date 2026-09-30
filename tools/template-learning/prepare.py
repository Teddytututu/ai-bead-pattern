from __future__ import annotations

import shutil
from pathlib import Path

from contracts import GenerationInput, GenerationOutput, Target, VERSION
from inventory import inventory, select_candidates
from io_utils import PROJECT, digest, write_json, write_jsonl

TOOL = Path(__file__).resolve().parent


def prepare(manifest: Path, data_root: Path, output: Path, seed: str) -> dict:
    rows, summary = inventory(manifest, data_root)
    candidates, quotas = select_candidates(rows, seed)
    # No overwrite/resume of partial runs: a new run ID preserves corrections.
    output.mkdir(parents=True, exist_ok=False)
    meta = output / 'meta'
    meta.mkdir()
    (output / 'pilot').mkdir()
    (output / 'reports').mkdir()
    (meta / 'schemas').mkdir()
    for label, model in (('input', GenerationInput), ('output', GenerationOutput), ('target', Target)):
        write_json(meta / 'schemas' / f'{label}.schema.json', model.model_json_schema())
    for name in ('task-contract.md', 'evaluation-protocol.md'):
        shutil.copyfile(TOOL / name, meta / name)
    write_jsonl(meta / 'inventory.jsonl', rows)
    write_json(meta / 'inventory-summary.json', summary)
    write_jsonl(output / 'pilot' / 'candidates.jsonl', candidates)
    write_jsonl(output / 'pilot' / 'training-manifest.jsonl', [])
    config = {
        'schemaVersion': VERSION, 'seed': seed, 'manifest': str(manifest.resolve()),
        'dataRoot': str(data_root.resolve()), 'manifestSha256': digest(manifest),
        'candidateQuotas': quotas, 'splitStatus': 'unassigned-until-design-group-review',
        'reviewer': None, 'budgets': {'batchSize': 1, 'workers': 1, 'timeoutSeconds': 300,
        'retries': 0, 'pilotCandidateLimit': 240, 'goldExampleTarget': 24,
        'reviewMinutesPerExampleCap': 15, 'maximumRunBytes': 2 * 1024 ** 3,
        'measuredPeakGpuBytes': None, 'measuredSecondsPerImage': None},
        'runtimeStatus': 'not-started', 'trainingAllowed': False,
        'codeSha256': {p.relative_to(PROJECT).as_posix(): digest(p)
                       for p in sorted([*TOOL.glob('*'),
                           *(PROJECT / 'services/sam2-sidecar/src/sam2_sidecar').glob('*.py'),
                           PROJECT / 'services/sam2-sidecar/pyproject.toml']) if p.is_file()},
    }
    write_json(meta / 'run-config.json', config)
    blockers = ['human-reviewer-unassigned', 'design-groups-and-heldout-split-unreviewed',
                'grid-layout-and-part-gold-unreviewed', 'model-smoke-not-run']
    if summary['trainingEligible'] == 0:
        blockers.append('no-qualified-training-pairs')
    if summary['failed']:
        blockers.append('original-integrity-failures')
    report = {'stage': 'FT0', 'status': 'in-progress', 'inventory': summary,
              'candidateCount': len(candidates), 'blockers': blockers,
              'note': 'Runtime results are recorded separately in meta/runtime.json; no quality gate passed.'}
    write_json(output / 'reports' / 'preparation.json', report)
    write_json(meta / 'artifact-hashes.json', {
        p.relative_to(output).as_posix(): digest(p) for p in sorted(output.rglob('*')) if p.is_file()
    })
    return report
