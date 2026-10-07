# 当前架构

主生成器版本为 0.12.0-source-sampling，定义见 [pipeline.ts](../packages/pattern-core/src/pipeline.ts)。两阶段神经网络路线的状态见 [训练路线](training.md)。

## 执行入口

~~~mermaid
flowchart LR
  Web[网页工作台] --> Core[Pattern Core]
  Web --> Gateway[Demo API / AI Gateway]
  Mini[微信小程序] --> SDK[WeChat SDK]
  SDK --> API[Pattern API]
  API --> Store[SQLite / 私有文件]
  API --> Worker[计算 Worker]
  Worker --> Core
  Worker --> Gateway
  Gateway --> Models[可选模型服务]
  Palettes[实体色卡] --> Core
~~~

网页在浏览器执行核心算法，Demo 服务提供静态文件及模型代理。小程序通过产品 API 上传和创建任务，计算在服务端完成。两者不是同一个 HTTP 入口。

教师审核工具及训练标注前端独立保存数据。教师输出尚未自动流入产品生成器。

## 主体图纸生成

1. 校验 RGBA、材料色卡、选项和分析证据，固定生成身份。
2. 根据主体形状、裁剪和占位要求选择画布，建立源图到格图的映射。
3. 采样源图，规划结构区域并保护有证据支持的细节。
4. 分别处理明暗和外／内轮廓，映射真实材料颜色。
5. 执行配色优化和网格精修，检查拓扑、色差、主体保真与可制作性。
6. 排序并返回推荐、best-effort 或无有效候选；导出材料统计及图纸。

A0/A1 是采样对照，MVP 是结构处理路线。没有训练好的全图网格预测器，也没有规则五官模板。生成入口过滤眼、鼻、嘴等五官关键点与部件掩码，五官采用统一像素采样、配色和清理。主体蒙版、身体关键点与非五官部件继续帮助轮廓、取样和评估；实验分析接口保留原始关键点证据。

## 颜色与结构约束

- preserve、adaptive、stylized 控制明暗；强度 0 旁路明暗调整，量化与精修仍可能产生色差。
- MARD 自动填色排除 H7；内外轮廓共用一个合规深色。Perler 黑色正常参与匹配，特殊材质不自动分配。
- 精修保护原图细节和部件边界，不根据双眼推导镜像轴。
- 缺少轮廓证据时给出诊断，不把画布边缘当作主体边界。
- PatternAlgorithm.adapt 处理已固定珠格及材料变化，不等于通用作品编辑和保存系统。

## 目录职责

| 目录 | 职责 |
| --- | --- |
| packages/pattern-core | 内存图像、网格、配色、质量评分、导出 |
| packages/material-palettes | 色卡注册、内容版本及材质限制 |
| packages/pattern-api-contracts、wechat-client | 请求校验、共享类型和微信适配 |
| services/pattern-api | 身份、上传、任务调度、持久化与导出 |
| services/ai-gateway | 模型目录、Provider、超时、证据融合及贡献记录 |
| services/*-sidecar | 独立 Python 模型服务和锁定环境 |
| apps/demo | 产品工作台、模型代理及实验页面 |
| apps/training-annotation | 人工眼睛目标封存 |
| apps/teacher-review、tools/teacher-loop | 原图到卡通图的教师闭环 |
| tools/*-gate、tools/auto-eval | 离线质量与偏好评测 |

GroundingDINO + SAM2 是当前自动主体／部件分析组合。MMPose、OpenCLIP、DINOv2 和像素提案为可选服务；模型目录存在条目不表示对应推理已经部署。人像关键点映射代码也不代表默认接入真实 MediaPipe 服务。

各包声明直接依赖，各 Python 服务保留独立锁文件。构建产物、日志、缓存和数据不进入 Git；部署与存储要求见 [远程开发](remote-development.md)。
