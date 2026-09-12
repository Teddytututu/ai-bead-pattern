# 真实宠物图基准集

本目录登记 40 张 Oxford-IIIT Pet 的真实照片，样本按品种 `sourceGroup` 分组，development 30 张、holdout 10 张。品种整体进入同一 split，留出集因此具备跨来源组检验能力。仓库只追踪清单与脚本，照片和 trimap 存放在 `work/real-pet-benchmark/`。

数据页：[Oxford-IIIT Pet Dataset](https://www.robots.ox.ac.uk/~vgg/data/pets/)。清单保留官方归档路径、来源、许可说明和下载后的 SHA-256。许可字段沿用数据页的 CC BY-SA 4.0 描述，照片对外再分发前请逐项核实图像条款。

## 获取数据

```bash
node tools/real-pet-benchmark/fetch-oxford-pet.mjs \
  --output work/real-pet-benchmark --limit 40
```

脚本下载官方 `images.tar.gz` 与 `annotations.tar.gz`，提取清单中的照片与 trimap，写出带 SHA-256 的 `work/real-pet-benchmark/manifest.json`。`--dry-run` 只显示下载计划；网络受限时可先手动放入两个归档再运行 `--archives <dir>`。

## 运行多尺寸基准

```bash
pnpm build
node tools/real-pet-benchmark/run.mjs \
  --manifest work/real-pet-benchmark/manifest.json \
  --output work/real-pet-benchmark/results \
  --sizes 24,32,48,64,80 --split holdout
```

结果包含每张照片、每个尺寸、baseline 与两个消融模式的候选图、`metrics.jsonl`、`metrics.csv`、`preference-export.jsonl` 和 `run.json`。`sourceGroup` 会进入每条记录，便于按品种分组汇总与去重留出。
