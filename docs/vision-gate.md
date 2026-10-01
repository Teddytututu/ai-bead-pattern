# 人像分析评测

Vision Gate 评测原图人像分析证据在固定 48×48 参考网格上的位置和区域质量。它不评测 SDXL 卡通风格，也不表示第二阶段网格网络已实现。

## 数据和指标

协议需要 30 张来源明确的人像及人工标签，覆盖正脸、侧转、遮挡、眼镜、弱光、背景和小主体。关键点用归一化源图坐标，区域使用参考格图的占用索引。

| 指标 | 门槛 |
| --- | ---: |
| 眼中心误差 ≤1 格 | ≥90% |
| 嘴中心误差 ≤1.5 格 | ≥90% |
| 面部包含率 >0.85 | ≥90% 样本 |
| 头发 Dice >0.50 | ≥80% 样本 |
| 衣物 Dice >0.50 | ≥80% 样本 |
| 高置信硬关键点失配 | ≤2% |

报告另含校准误差、Brier 分数和逐样本诊断。真实结果固定数据、协议、模型和图像身份。

## 验证评测器

~~~bash
pnpm vision-gate:fixtures --output work/vision-gate/protocol
pnpm vision-gate:report --manifest work/vision-gate/protocol/manifest.json --predictions work/vision-gate/protocol/predictions.jsonl --output work/vision-gate/protocol/report.md --json work/vision-gate/protocol/summary.json --diagnostics work/vision-gate/protocol/diagnostics
~~~

fixtures 生成合成标签和完美预测，只检查 schema、统计、CLI 及导出。真实人工数据必须使用独立数据集身份，不能把夹具报告当作模型准确率。
