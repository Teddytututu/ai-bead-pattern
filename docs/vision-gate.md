# Portrait Vision Gate

Portrait Vision Gate measures whether the portrait providers locate the eyes and mouth at the resolution used by a 48 x 48 bead pattern, and whether face, hair, and clothes regions occupy plausible grid areas.

## Protocol

- Dataset: 30 licensed or owned portrait images.
- Coverage: front face, light profile, three-quarter view, glasses, bangs, occlusion, low light, complex background, and small full-body portraits.
- Landmark annotations: normalized source coordinates for `left-eye-center`, `right-eye-center`, and `mouth-center`.
- Region annotations: occupied cell indices on a fixed 48 x 48 reference grid for `face-skin`, `hair`, and `clothes`.
- Predictions: one JSONL record per manifest sample, with stable dataset, protocol, model, and image identity.

The protocol fixture generator produces synthetic annotations and perfect predictions for checking the evaluator itself:

```powershell
pnpm vision-gate:fixtures --output work/vision-gate/protocol
pnpm vision-gate:report `
  --manifest work/vision-gate/protocol/manifest.json `
  --predictions work/vision-gate/protocol/predictions.jsonl `
  --output work/vision-gate/protocol/report.md `
  --json work/vision-gate/protocol/summary.json `
  --diagnostics work/vision-gate/protocol/diagnostics
```

Protocol fixtures verify schema, statistics, CLI output, and diagnostic exports. Real model results use a separate dataset ID and real human annotations.

## Gate Criteria

| Metric | Target |
| --- | ---: |
| Eye centers within 1 grid cell | at least 90% |
| Mouth center within 1.5 grid cells | at least 90% |
| Face containment above 0.85 | at least 90% of samples |
| Hair Dice above 0.50 | at least 80% of samples |
| Clothes Dice above 0.50 | at least 80% of samples |
| High-confidence hard landmark mismatch | at most 2% |

The summary also reports expected calibration error and Brier score. Diagnostics include per-sample outcomes, per-landmark errors, per-region overlap, and calibration bins.
