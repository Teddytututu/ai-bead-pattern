# Mask Failure Gate

## 目标

这一轮验证一个产品假设：BiRefNet 主体 mask 出现明显偏差时，用户能在短时间内用少量笔画修到可接受，并让最终拼豆图更受偏好。

评测使用同一张规范化源图生成 AI mask、修正 mask 和前后 Pattern。当前 Shape IoU 的参考 mask 会随输入变化，因此只留作算法诊断。Gate 使用人工判断和交互成本。

## 样本组成

首批 40 张：

| 分组 | 数量 | 主要覆盖 |
| --- | ---: | --- |
| 人像 | 12 | 飞发、同色背景、肢体漏检、椅子粘连、侧脸、遮挡 |
| 宠物 | 12 | 长毛、黑白毛色、尾巴、耳尖、毛边、人与宠物同框 |
| 插画与物体 | 8 | 硬边、透明背景、孔洞、细长结构 |
| Control 与 Extreme | 8 | 高质量初始 mask、低光、模糊、强同色背景 |

每张样本记录来源许可和引用标识。真实图片、规范化源图、mask 与评测记录统一存放在 `work/mask-gate/`，Git 会忽略该目录。

## 通过标准

| 指标 | 标准 |
| --- | ---: |
| 30 秒内修到可接受 | >= 80% |
| P50 修正时间 | <= 15 s |
| P90 修正时间 | <= 30 s |
| 中位笔画数 | <= 6 |
| After Pattern 偏好率 | >= 75% |

取消与错误尝试进入失败样本分母。报告同时列出手机样本数、取消数和错误数。

## 生成真实 BiRefNet sidecar

准备 manifest，可从 `tools/mask-gate/manifest.example.json` 开始。启动本地 rembg 服务后执行：

```bash
pnpm mask-gate:sidecars \
  --manifest work/mask-gate/manifest.json \
  --output work/mask-gate/sidecars \
  --endpoint http://127.0.0.1:7000 \
  --model birefnet-general-lite
```

每个样本会生成：

```text
portrait-01.source.png
portrait-01.mask.png
portrait-01.analysis.json
```

`source.png` 已完成 EXIF 方向归一和等比例尺寸限制。Gateway 与后续编辑使用同一份像素。`analysis.json` 保存模型、后处理参数、Gateway commit、上游 revision、绑定落盘 mask 的 sidecar revision、尺寸和文件哈希。

## 浏览器采集

生成 sidecar 后启动 Demo：

```bash
pnpm demo
```

打开指定样本：

```text
http://127.0.0.1:4173/apps/demo/?maskGateIndex=/work/mask-gate/sidecars/index.json&sample=portrait-01
```

页面会加载该样本的规范化源图、真实 BiRefNet mask 和证据 revision，并先生成 Before Pattern。点击“修正主体”后开始计时：

1. 确认主体后，页面重新生成 After Pattern，并开放前后评价。
2. 取消编辑后，页面生成 `cancelled` 记录，评价固定为 `unrated`。
3. 填写初始主体判断；确认流程继续填写修正后主体和图纸偏好。
4. 点击“导出 attempt”，浏览器下载 `<imageId>.attempt.json`。

将下载文件作为下一节采集命令的 `--input`，即可写入统一的 `records.jsonl`。

## 采集一次编辑记录

编辑器确认回调已经提供完整 `MaskEditSession`。评测输入 JSON 采用：

```json
{
  "imageId": "portrait-01",
  "outcome": "confirmed",
  "correctionStartedAt": 1787097600000,
  "correctionEndedAt": 1787097612000,
  "beforeGenerationId": "before-generation-id",
  "afterGenerationId": "after-generation-id",
  "initialSubjectAcceptable": false,
  "subjectAcceptable": true,
  "patternPreference": "after",
  "deviceClass": "mobile",
  "session": {
    "baseRevision": "sidecar:rembg-http:birefnet-general-lite:mask-v2-certainty-v1:...:u8:...",
    "strokes": [],
    "cursor": 0
  }
}
```

追加记录：

```bash
pnpm mask-gate:collect \
  --manifest work/mask-gate/manifest.json \
  --sidecar work/mask-gate/sidecars/portrait-01.analysis.json \
  --input work/mask-gate/attempts/portrait-01.json \
  --records work/mask-gate/records.jsonl
```

采集器会从 sidecar 还原 AI evidence，用 Pattern Core 重放活动笔画，生成稳定 confirmed revision，并按真实 mask 差值计算修正面积。

首轮报告要求每个 `imageId` 一条记录。重复 ID 会直接报错，防止单一样本重复影响结果。

## 生成报告

```bash
pnpm mask-gate:report \
  --manifest work/mask-gate/manifest.json \
  --records work/mask-gate/records.jsonl \
  --output work/mask-gate/report.md \
  --json work/mask-gate/summary.json
```

报告先校验 40 张 manifest 全覆盖、类别配额和至少 8 条手机记录，再给出各项阈值的 PASS/FAIL。涉及人工 reference mask 的 10 至 15 张样本，可在后续扩展同一参考下的 base/corrected IoU。

## 真机小样本

从失败集中抽取 8 至 10 张，在真实手机浏览器完成一次评测。记录手指遮挡、小笔刷精度和 30 秒完成率。结果达到 Gate 时维持当前整图编辑；细结构操作受阻时，再进入缩放和平移设计。
