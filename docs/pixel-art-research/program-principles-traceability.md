# 像素画理念程序追踪表

状态定义：`已实现` 表示存在真实运行行为和行为测试；`部分实现` 表示已有运行行为且仍有明确缺口；`施工中` 表示本轮正在编程；`待实现` 表示仍缺真实行为。

| 主题 | 程序原理 | 模块 / 接口 | 参数 | 指标 | 测试 | 状态 |
|---|---|---|---|---|---|---|
| 构图、尺度、细节预算、焦点、负空间、比例 | 先分配画布资源，再分配语义细节 | canvas planner, `CanvasPlan`, art direction | auto/fixed sizes, occupancy, focus | canvasFit, detail budgets | canvas/art-direction tests | 已实现 |
| 剪影、连通、轮廓节奏、像素簇、孤立格、色带、锯齿、曲线 | 形状占用先于颜色，弱证据边界允许簇整理 | shape, grid refinement | refinement mode, penalties | IoU, components, holes, stripes | shape/refinement tests | 已实现 |
| 人物、宠物、物件身份关键点 | 高价值特征先落格并锁定 | feature templates/planning/evaluation | feature budgets, contrast | hard completeness, collision, symmetry error | feature tests/gate | 已实现 |
| 明度、光源、体积、投影、环境光、反射 | 先建区域明度角色，再映射实体色 | value/palette planning | levels, separations | value order, region contrast | value/palette tests | 已实现 |
| 有限色板、色相偏移、饱和度、Lab、替代色、库存 | 先满足角色关系，再优化色差和库存 | palette planner, material palette | max colors, allowed ids | palette cost, Delta E | palette tests | 已实现 |
| 抗锯齿、抖动、过渡预算、切换、噪声 | 过渡格受区域和制作预算约束 | art direction/grid refinement | dither/AA budget | switches, isolated cells, bands | art-direction/refinement tests | 已实现 |
| 场景、透视、景深、遮挡、自然物、建筑 | 按层级、焦点和结构分配细节 | scene/material profiles | depth/focus/material | layer and occlusion budgets | art-direction tests | 已实现 |
| 图块、地形、角、边、接缝、变体 | 边界签名决定 tile 兼容 | tile profile/export | edge state | seam signature, variant budget | art-direction tests | 已实现 |
| 动画姿势、动作弧线、一致网格与色板、关键帧 | 按剪影和特征可见度选静态帧 | animation profile | frame policy | key-frame score, consistency | art-direction tests | 已实现 |
| 材质方向、纹理密度、高光模板 | 纹理服从形体方向、光照和焦点 | material profile | material kind/density | texture and reflection budget | art-direction tests | 已实现 |
| 选择性描边、开放边缘、线宽、受光/背光轮廓 | 轮廓样式由光照和区域对比决定 | outline profile | mode/light direction | light/shadow opacity | art-direction tests | 已实现 |
| 清晰、细腻、复古风格 | 每种风格使用完整约束组合 | style profile | profile id | profile diagnostics | art-direction tests | 已实现 |
| 拼豆制作约束 | 一格一色并控制连接、豆数、色数和替代色 | evaluation/export | craft profile | craft complexity | algorithm/export tests | 部分实现 |
| 候选、结构优先评分、偏好学习 | 排序优先剪影和身份，再看明度、簇、色差、制作；人工标签形成有界更新 | candidate evaluation, PreferenceRecord V2, learner, active sampler | score weights, priors, confidence bounds | ordered sub-scores, holdout gain, coverage | preference/ranking/replay tests | 已实现 |
| 标注工作台与局部问题定位 | 2-4 候选同屏，轴评分、问题标签和格子定位共同形成监督记录 | demo preference workbench | overlays, severity, confidence, session | completion, replay, annotation coverage | UI unit + Playwright desktop/mobile | 已实现 |
| 视觉模型与结构化提案 | 神经模块输出统一分析、提案和偏好特征，确定性规划器执行实体约束 | ai-gateway provider/composite analyzer | capability, model id, timeout, input limit | confidence, latency, contribution | provider contract/probe/ablation tests | 部分实现 |
| 数据冻结、分层学习与模型回退 | 同源分组后切分训练/验证/留出集，按类别保留全局先验 | preference dataset/version registry | split seed, strata, min samples | holdout accuracy, confidence interval | split/replay/version tests | 已实现 |
| 工具、导出、整数倍预览、图纸、色号、透明边缘、诊断 | 输出材料表、网格预览、模型来源和阶段诊断 | demo/export | preview/export options | export validity | demo/E2E | 已实现 |

## 真实评测证据

- 冻结集：64 张，人物、宠物、插画、物件四类；8 条路线共 512 条记录，生成错误 0。
- `mvp-auto-quality`：总分均值 0.657，剪影 0.849，像素簇 0.916，制作易用 0.891，平均颜色数 5.16。
- `a0-nearest`：总分均值 0.561，剪影 0.751，像素簇 0.697，制作易用 0.717，平均颜色数 9.02。
- 真实 BiRefNet：512×325 输入，健康状态 ready，分析响应 200，返回主体蒙版、语义区、重要性图、建议裁剪和模型溯源。
- 视觉模型范围：BiRefNet 已有本机真实推理；SAM 2、MediaPipe、MMPose、DINOv2、SigLIP、Depth Anything V2、SD-piXL 已完成冻结目录与 Provider 合同，运行时按部署状态展示。
