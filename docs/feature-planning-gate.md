# Feature Planning Gate

Feature Planning converts portrait landmarks into discrete eye, mouth, and nose templates before color quantization. The gate measures the resulting candidate rankings at 32, 48, and 64 cells.

## Evaluation unit

Each portrait produces one record per target size. A record contains both eyes, the mouth, and the nose, with:

- ranked template candidates;
- human-accepted candidate ids;
- the selected candidate;
- occupied cells;
- visible cells in the final pattern.

The report evaluates:

- eye Top-2 acceptance at or above 90%;
- mouth Top-2 acceptance at or above 85%;
- zero hard-feature collisions;
- complete hard-feature visibility at or above 95%;
- all 30 portraits across 32, 48, and 64 cells.

## Commands

```bash
pnpm feature-gate:fixtures --output work/feature-gate/protocol
pnpm feature-gate:report \
  --manifest work/feature-gate/protocol/manifest.json \
  --records work/feature-gate/protocol/records.jsonl \
  --output work/feature-gate/protocol/report.md \
  --json work/feature-gate/protocol/summary.json \
  --diagnostics work/feature-gate/protocol/diagnostics
```

The protocol fixture dataset validates schema, metrics, commands, and report generation. A production Gate uses a separately identified portrait dataset and human acceptance labels.

The Demo Analysis Viewer includes a `五官落格` layer. It projects resolved grid cells back through the proportional canvas fit, so rectangular source images retain their geometry.
