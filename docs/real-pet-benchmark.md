# 真实宠物图评测协议

当前评测协议登记 Oxford-IIIT Pet 的 40 张真实照片：30 张 development、10 张 holdout，按品种 `sourceGroup` 分组。所有同品种图像保持同一 split，跨组留出结果可反映新来源组上的泛化。

评测网格固定为 24、32、48、64、80；每张图运行 `baseline`、`ablation-no-shape`、`ablation-area-resize`。每条结果保留来源组、split、尺寸、模式、候选分数、结构指标、工艺指标和输出路径，人工偏好写入 `preference-export.jsonl` 后可交给 `tools/auto-eval` 的偏好学习流程。

照片和 trimap 属于外部数据资产，下载到 `work/real-pet-benchmark/` 并通过 SHA-256 写入运行 manifest。仓库提交清单、脚本和少量可查看样例输出；外部图片按数据页的授权条款逐项核验后再决定共享范围。

```bash
node tools/real-pet-benchmark/fetch-oxford-pet.mjs --output work/real-pet-benchmark --limit 40
pnpm build
node tools/real-pet-benchmark/run.mjs --manifest work/real-pet-benchmark/manifest.json --split holdout --sizes 24,32,48,64,80
```

官方来源：[Oxford-IIIT Pet Dataset](https://www.robots.ox.ac.uk/~vgg/data/pets/)。

## 2026-09-05 实际运行记录

受控批次 `results-600-20260905` 使用 40 张照片（development 30、holdout 10）、24/32/48/64/80 五档网格，以及 `mvp`、`area`、`nearest` 三个确定性基线，共生成 600 个 PNG 和 600 条指标记录。三个基线均完成生成，失败清单记录为 0 条。

归档在提取前执行 SHA-256 校验：`images.tar.gz` 为 `67195c5e1c01f1ab5f9b6a5d22b8c27a580d896ece458917e61d459337fa318d`，`annotations.tar.gz` 为 `52425fb6de5c424942b7626b428656fcbd798db970a937df61750c0f1d358e91`。容器环境使用 `tar --no-same-owner`，清单成员在提取前完成存在性检查。

结果目录同时提供 `aggregate.json`、`confidence-intervals.json`/`.csv`、`failures.json`/`.csv`、`verification.json`、`ab-batch.json` 和 `preference-export.jsonl`。置信区间采用 3000 次非参数 bootstrap（seed `20260905`），分组维度为基线与网格尺寸；人工 A/B 批次包含每张图每个尺寸下的 `mvp-vs-area` 与 `mvp-vs-nearest` 配对。
