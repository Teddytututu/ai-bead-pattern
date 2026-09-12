# 人工 A/B 标注闭环

`results-600-20260905/ab-batch.json` 含 40 张真实图、5 个尺寸和两条基线对照，共 400 对。每对记录 A/B PNG 路径、来源分组、尺寸与模式；`choice` 留空代表待人工判断。

在可查看 PNG 的终端执行：

```bash
node tools/real-pet-benchmark/label-ab.mjs \
  work/real-pet-benchmark/results-600-20260905/ab-batch.json \
  work/real-pet-benchmark/results-600-20260905/ab-batch.labeled.json
node tools/real-pet-benchmark/import-ab-labels.mjs
```

导入脚本只接受 `a`、`b`、`tie`，输出 Preference V2 JSONL，`raterType` 固定为 `human`。完成标注后，将 JSONL 导入 demo preference runtime；runtime 会按冻结 development/holdout split 训练、比较并选择模型，随后通过 `PatternAlgorithmConfig.preferenceRanker` 进入默认候选排序。
