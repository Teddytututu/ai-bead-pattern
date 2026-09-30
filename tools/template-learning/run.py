"""Run with services/sam2-sidecar/.venv/Scripts/python.exe (or its POSIX peer)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description='Offline FT0/FT1 tools; no training or downloads')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('prepare')
    init.add_argument('--manifest', type=Path, required=True)
    init.add_argument('--data-root', type=Path, required=True)
    init.add_argument('--output', type=Path, required=True)
    init.add_argument('--seed', default='ft0-v1')
    runtime = commands.add_parser('runtime')
    runtime.add_argument('--run', type=Path, required=True)
    runtime.add_argument('--image', type=Path, default=Path('apps/demo/assets/sample-cat.png'))
    worker = commands.add_parser('_runtime-worker', help=argparse.SUPPRESS)
    worker.add_argument('--image', type=Path, required=True)
    worker.add_argument('--output', type=Path, required=True)
    validate = commands.add_parser('validate')
    validate.add_argument('--input', type=Path, required=True)
    validate.add_argument('--prediction', type=Path)
    validate.add_argument('--target', type=Path)
    pilot = commands.add_parser('grid-pilot')
    pilot.add_argument('--run', type=Path, required=True)
    pilot.add_argument('--limit', type=int, default=24)
    pilot.add_argument('--calibrations', type=Path)
    groups = commands.add_parser('group-pilot')
    groups.add_argument('--run', type=Path, required=True)
    neural = commands.add_parser('preannotate')
    neural.add_argument('--run', type=Path, required=True)
    neural.add_argument('--limit', type=int, default=24)
    neural_worker = commands.add_parser('_preannotate-worker', help=argparse.SUPPRESS)
    neural_worker.add_argument('--job', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        from prepare import prepare
        result = prepare(args.manifest, args.data_root, args.output, args.seed)
    elif args.command == '_runtime-worker':
        from runtime import worker
        worker(args.image, args.output)
        return
    elif args.command == 'runtime':
        from runtime import probe
        result = probe(args.run, args.image)
    elif args.command == 'grid-pilot':
        from grid_reader import pilot
        result = pilot(args.run, args.limit, args.calibrations)
    elif args.command == 'group-pilot':
        from grouping import group_inventory
        result = group_inventory(args.run)
    elif args.command == 'preannotate':
        from preannotate import preannotate
        result = preannotate(args.run, args.limit)
    elif args.command == '_preannotate-worker':
        from preannotate import worker
        worker(args.job)
        return
    else:
        from contracts import GenerationInput, GenerationOutput, Target, validate_output, validate_target
        request = GenerationInput.model_validate_json(args.input.read_text(encoding='utf-8'))
        if args.prediction:
            value = GenerationOutput.model_validate_json(args.prediction.read_text(encoding='utf-8'))
            validate_output(value, request)
        if args.target:
            validate_target(Target.model_validate_json(args.target.read_text(encoding='utf-8')), request)
        result = {'status': 'valid', 'inputId': request.inputId}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command == 'runtime' and result['status'] != 'ready':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
