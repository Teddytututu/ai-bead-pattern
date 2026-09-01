# Mask Failure Gate V2

## 目标

Gate 评估 BiRefNet 主体分割出现偏差后，用户能否在 30 秒内通过粗略圈选和少量局部笔刷修正主体，并让修正后的拼豆图获得更高偏好。

交互记录和图纸偏好分开保存。修正效率以一张图片的一次编辑为单位；图纸评价使用隐藏前后身份的 A/B 选择。

## 40 张样本

| 类别 | Targeted failure | Clean control | Extreme | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 人像 | 10 | 1 | 1 | 12 |
| 宠物 | 10 | 1 | 1 | 12 |
| 插画 | 6 | 1 | 1 | 8 |
| 物体 | 6 | 1 | 1 | 8 |

真实图片、规范化源图、mask 和评测记录存放在 `work/mask-gate/`。仓库保存工具、schema、示例和汇总报告。

## 页面流程

```text
sample-loaded
-> initial-rated
-> accepted / editing
-> confirmed / cancelled / error
-> corrected-mask-rated
-> blind-pattern-rated
-> exported
```

1. 选择初始主体评价并锁定。
2. 初始主体可接受时点击“接受并完成”。
3. 初始主体需修正时进入编辑器，完成确认、取消或异常记录。
4. 确认后评价主体，再比较方案 A 与方案 B。
5. 导出 `<imageId>.attempt.json`。

A/B 左右顺序由 `datasetId + imageId + raterId + protocolVersion` 的 SHA-256 稳定决定。页面仅显示 A/B，采集器还原为 `before`、`after` 或 `tie`。

## Manifest V2

从 `tools/mask-gate/manifest.example.json` 开始准备数据。每个样本包含：

- `category`: `portrait | pet | illustration | object`
- `cohort`: `targeted-failure | clean-control | extreme`
- `failureTags[]`
- `subjectCount`
- `targetMobile`
- 图片许可与来源引用

Manifest 同时固定协议版本、样本顺序 seed、模型配置和 Core、Demo、Gateway 提交身份。

## 候选池与冻结

候选池工具从 Wikimedia Commons 获取 52 张明确许可图片，并为每张下载图保存来源身份。断点续传仅复用来源引用与下载地址完全一致的文件。

```bash
pnpm mask-gate:build-pool \
  --output work/mask-gate/candidates \
  --pool work/mask-gate/candidate-pool.json

pnpm mask-gate:contact-sheet \
  --pool work/mask-gate/candidate-pool.json \
  --images work/mask-gate/candidates \
  --output work/mask-gate/contact-sheet.png

pnpm mask-gate:freeze \
  --pool work/mask-gate/candidate-pool.json \
  --output work/mask-gate
```

冻结结果包含 40 张 `manifest.json`、manifest fingerprint、固定样本顺序和许可清单。联系表用于冻结前检查错类、多主体、主体含糊和异常长宽比。

## 生成 BiRefNet Sidecar

```bash
pnpm mask-gate:sidecars \
  --manifest work/mask-gate/manifest.json \
  --output work/mask-gate/sidecars \
  --endpoint http://127.0.0.1:7000 \
  --model birefnet-general-lite
```

Sidecar 完成 EXIF 方向归一和等比例尺寸限制，并保存源图哈希、mask 哈希、数值指纹、模型配置、manifest fingerprint 和 evidence revision。

## 五样本协议 Pilot

```bash
pnpm mask-gate:pilot \
  --manifest work/mask-gate/manifest.json \
  --sidecars work/mask-gate/sidecars \
  --output work/mask-gate/pilot
```

Pilot 固定选择 2 张人像、2 张宠物和 1 张物体或插画，覆盖 accepted、confirmed、cancelled、error、A/B、记录收集与确认重放。输出包含五个 attempt、`records.jsonl`、`preferences.jsonl`、`report.md`、`summary.json`、`replay.json` 和四张诊断 CSV。时间戳与设备标签属于确定性协议夹具；真实参与者和真实设备记录进入正式采集文件。

## 浏览器采集

```bash
pnpm demo
```

```text
http://127.0.0.1:4173/apps/demo/?maskGateIndex=/work/mask-gate/sidecars/index.json&sample=portrait-01&rater=reviewer-a
```

页面会加载规范化源图和真实 BiRefNet mask，保持原始宽高比，并生成初始图纸快照。第一笔 PointerEvent 决定 `mouse | touch | pen` 输入记录。

## 汇总记录

```bash
pnpm mask-gate:collect \
  --manifest work/mask-gate/manifest.json \
  --sidecar work/mask-gate/sidecars/portrait-01.analysis.json \
  --input work/mask-gate/attempts/portrait-01.json \
  --records work/mask-gate/records.jsonl \
  --preferences work/mask-gate/preferences.jsonl
```

interaction 使用一图一条记录；preference 使用 `imageId:raterId` 唯一键。采集器从 Sidecar 重放编辑 session，计算真实修正面积并验证所有协议身份。

每个 confirmed 样本需要两名独立评审者。第二名评审者可直接对隐藏顺序的图纸结果记录选择：

```bash
pnpm mask-gate:collect-preference \
  --interaction work/mask-gate/interactions/portrait-01.json \
  --rater reviewer-b \
  --choice left \
  --output work/mask-gate/preferences.jsonl
```

## 报告

```bash
pnpm mask-gate:report \
  --manifest work/mask-gate/manifest.json \
  --records work/mask-gate/records.jsonl \
  --preferences work/mask-gate/preferences.jsonl \
  --output work/mask-gate/report.md \
  --json work/mask-gate/summary.json \
  --diagnostics work/mask-gate/diagnostics
```

诊断目录包含类别、failure tag、设备输入和 clean-control 保留率四张 CSV。

核心阈值：

| 指标 | 标准 |
| --- | ---: |
| 30 秒内解决率 | >= 80% |
| P50 修正时间 | <= 15 s |
| P90 修正时间 | <= 30 s |
| 中位笔画数 | <= 6 |
| After Pattern A/B 偏好率 | >= 75% |
| Control Preservation | >= 90% |
| 真实手机记录 | >= 8 |

取消和异常进入 30 秒解决率分母。P50、P90、笔画数和修正面积仅统计 confirmed 且修正后主体可接受的样本。比例指标同时输出 Wilson 95% 区间。
