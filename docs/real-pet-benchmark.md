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
