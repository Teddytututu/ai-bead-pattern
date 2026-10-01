# AI Gateway

Gateway 把不同模型封装为统一 Provider，负责请求校验、能力选择、超时／取消、结果归一、证据融合和贡献记录。模型配置由服务端决定，不能由用户上传任意端点。

## 当前接入

| 能力 | 实现 |
| --- | --- |
| 主体抠图 | rembg／BiRefNet HTTP 适配 |
| 主体与部件蒙版 | GroundingDINO Tiny + SAM 2.1 Small |
| 交互分割 | SAM2，接受框、点和粗圈 |
| 宠物关键点 | 可选 MMPose／RTMPose |
| 像素化和风格提案 | 可选 Pixel proposal |
| 相似度和偏好特征 | 可选 OpenCLIP、DINOv2 |
| 人像证据适配 | 关键点与语义映射代码；默认入口未部署真实 MediaPipe 推理 |

模型目录见 [model-catalog.ts](src/model-catalog.ts)，公共入口见 [index.ts](src/index.ts)。目录登记不表示服务已启动，固定 revision 也不表示质量已经验收。

## 使用边界

Demo 通过 apps/demo/server/ai-api.mjs 调用 Gateway，产品 API 的 Worker 通过配置启用主体分析。HTTP 模型服务各自持有权重和独立环境。

分析记录原图尺寸、来源、模型版本、confidence 和 provenance；人工确认增加 trust，不覆盖原始模型置信度。缺少部件时返回缺失证据，不用规则补出五官。

pet-analysis.ts 中的旧几何推断仍供离线评测及公开兼容调用使用，正式 Gateway 不自动将其当作真实模型输出。视觉评分是排序证据，不是人工质量真值。

客户端取消或超时结束本次等待，不保证 sidecar 中已开始的 GPU 运算立即中止。

## 验证

~~~bash
pnpm --filter @ai-bead-pattern/ai-gateway typecheck
pnpm --filter @ai-bead-pattern/ai-gateway test
~~~

Provider 合同测试与真实模型烟测分开。各 sidecar 的 README 维护端口、模型缓存和设备选择，完整执行链路见 [架构](../../docs/architecture.md)。
