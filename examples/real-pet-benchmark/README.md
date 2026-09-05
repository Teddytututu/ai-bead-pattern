# Real pet benchmark example

`sample-cat.png` 与 `sample-cat-mask.png` 是仓库现有的高分辨率真实风格猫咪示例资产。运行下面的命令会生成 24、32、48、64、80 五种网格，并同时导出 baseline、`ablation-no-shape`、`ablation-area-resize` 三组结果：

```bash
pnpm build
node examples/real-pet-benchmark/run-sample.mjs
```

PNG 结果、`metrics.csv`、`metrics.jsonl` 和 `preference-export.jsonl` 可直接用于人工 A/B 标注；Oxford-IIIT Pet 的 40 图分组基准通过 `tools/real-pet-benchmark/fetch-oxford-pet.mjs` 获取，照片与模型输出均保存在 `work/`。
