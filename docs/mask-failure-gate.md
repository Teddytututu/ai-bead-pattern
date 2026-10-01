# 主体蒙版交互评测

Mask Gate 评估分割失败后，用户修正主体的耗时、操作量和图纸偏好。当前离线 V2 工具保留 BiRefNet 基线，与产品默认使用 Grounded-SAM-2 的配置分开记录，不能互相冒充模型结果。

## 协议

冻结 40 张样本，包含人像、宠物、插画和物体；记录 targeted-failure、clean-control、extreme 分组、来源、设备和模型配置。示例见 [manifest.example.json](../tools/mask-gate/manifest.example.json)。

先评价初始主体，再接受或编辑；编辑可确认、取消或失败。确认后评价主体并盲评前后图纸 A/B。交互和偏好分开保存，A/B 顺序由稳定身份哈希确定。

取消及错误计入解决率分母。耗时等统计只取符合协议的确认记录，不能把合成时间戳当作用户实测。

## 工具流程

在仓库根目录：

~~~bash
pnpm mask-gate:build-pool --output work/mask-gate/candidates --pool work/mask-gate/candidate-pool.json
pnpm mask-gate:contact-sheet --pool work/mask-gate/candidate-pool.json --images work/mask-gate/candidates --output work/mask-gate/contact-sheet.png
pnpm mask-gate:freeze --pool work/mask-gate/candidate-pool.json --output work/mask-gate
pnpm mask-gate:sidecars --manifest work/mask-gate/manifest.json --output work/mask-gate/sidecars --endpoint http://127.0.0.1:7000 --model birefnet-general-lite
~~~

下载、冻结和真实模型调用属于独立数据操作，不作为文档检查执行。每次评测固定数据集、模型和代码身份，保护已有冻结目录。

pnpm mask-gate:pilot 生成协议夹具，collect 和 collect-preference 校验并汇总记录，report 生成统计及诊断。具体参数见 [工具入口](../tools/mask-gate/bin/)。

## 当前门槛

| 指标 | 阈值 |
| --- | ---: |
| 30 秒内解决率 | ≥80% |
| P50／P90 修正时间 | ≤15／30 秒 |
| 中位笔画数 | ≤6 |
| 修正后图纸偏好率 | ≥75% |
| Clean control 保留率 | ≥90% |
| 真实手机记录 | ≥8 |

每个 confirmed 样本需要独立图纸偏好评价，比例同时报告置信区间。协议夹具和浏览器模拟仅验证实现，不代表真实参与者、手机或模型质量已通过。
