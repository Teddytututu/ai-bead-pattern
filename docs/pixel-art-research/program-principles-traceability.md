# 像素画理念程序追踪表

状态定义：`已实现` 表示存在真实运行行为和行为测试；`部分实现` 表示已有运行行为且仍有明确缺口；`施工中` 表示本轮正在编程；`待实现` 表示仍缺真实行为。

| 主题 | 程序原理 | 模块 / 接口 | 参数 | 指标 | 测试 | 状态 |
|---|---|---|---|---|---|---|
| 构图、尺度、细节预算、焦点、负空间、比例 | 先分配画布资源，再分配语义细节 | canvas planner, `CanvasPlan`, art direction | auto/fixed sizes, occupancy, focus | canvasFit, detail budgets | canvas/art-direction tests | 已实现 |
| 剪影、连通、轮廓节奏、像素簇、孤立格、色带、锯齿、曲线 | 形状占用先于颜色，弱证据边界允许簇整理；中心线与 F4 实体连通分别评价 | shape, grid refinement, topology metrics, craft connectivity | refinement mode, node weights, F4 bridge penalties | IoU, clDice, endpoint/junction F1, components, holes, stripes, fragile bridges | shape/refinement/connectivity tests | 已实现；256 邻域 oracle、D4 对称与双孔洞测试进行中 |
| 人物、宠物、物件身份关键点 | 高价值特征先落格并锁定；侧脸宠物按方向分配单眼、口鼻、耳尖、尾尖与脚掌 | pet analysis, feature templates/planning/evaluation | profile evidence, direction evidence, feature budgets, contrast | hard completeness, collision, symmetry error | pet/feature tests/gate | 已实现 |
| 明度、光源、体积、投影、环境光、反射 | 先建区域明度角色，再映射实体色 | value/palette planning | levels, separations | value order, region contrast | value/palette tests | 已实现 |
| 有限色板、色相偏移、饱和度、Lab、替代色、库存 | 先满足角色关系，再优化色差和库存；灰度角色限制在低色度材料梯度 | palette planner, material palette | max colors, allowed ids, neutral role chroma 8/12 | palette cost, Delta E, neutral-role purity | palette tests | 已实现 |
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
| 主体与实例分割 | BiRefNet 提供自动主体；Grounded-SAM2 保持框、标签、分数和蒙版顺序，项目生成稳定实例 ID；SAM 3 作为文本多实例实验项 | ai-gateway, sam2 sidecar, pet geometry fusion | prompt, box/text threshold, NMS, multimask, model revision | instance recall, Boundary F-score, stability, latency | provider/segmentation/pet-pipeline tests | SAM 2 已接入；SAM 3 实验 Provider 进行中 |
| 宠物关键点与逐实例几何 | AP-10K 提供双眼、鼻、颈、尾根和四肢；AnimalPose 提供耳根；耳尖融合蒙版曲率与骨架端点；多实例聚合蒙版跳过全局合成脸 | mmpose sidecar, pet geometry fusion, pet analysis | 256 input, per-instance prefix, ear-tip fusion | landmark coverage, ear-tip direction, instance binding | pet geometry/pose/feature tests | 已实现 AP-10K batch 与实例前缀；AnimalPose 对照进行中 |
| 逐实例身份视图 | OpenCLIP 承担类别和语义门控；DINOv2 承担头部、眼鼻、耳朵和花纹的局部身份；每只宠物独立裁剪与评分 | auto-eval OpenCLIP/DINO scorers, regional views | view weights, face confidence, spatial window | weakest-instance identity, local retention, collision | scorer/view/candidate-runner tests | OpenCLIP 逐实例 mask、关键点裁剪与最弱实例惩罚已实现；DINOv2 真实区域证据接线进行中 |
| DINO 稠密对应升级 | DINOv2-small 作为 Apache-2.0 生产默认；DINOv3 作为高分辨率 dense/sparse matching 实验项 | dinov2 sidecar, AI Gateway experimental provider | patch size, local window, relative coordinates, model revision | patch correspondence, misplaced-feature sensitivity, P95 latency | frozen-pet ablation | DINOv2 Provider 已接入；区域证据和 DINOv3 消融进行中 |
| 学习型像素化提案 | cell-controllable 模型只生成结构候选，随后执行网格重建、关键点保持、实体色板和制作规则 | learned proposal provider, candidate generator | integer cell size, proposal count, seed | grid consistency, feature retention, candidate diversity | provider and frozen-set ablation | MYOS 官方实现列为非商业离线教师，真实接线进行中 |
| 生成式像素提案 | 扩散 img2img 生成风格候选，最近邻重建到目标网格后进入确定性筛选 | pixel-proposal sidecar | strength, guidance, seed, target size | candidate change, palette validity, craft feasibility | sidecar engine/contracts tests | 已接入 Stable Diffusion img2img 路线 |
| 视觉模型与结构化提案 | 神经模块输出统一分析、提案和偏好特征，确定性规划器执行实体约束 | ai-gateway provider/composite analyzer | capability, model id, timeout, input limit, license | confidence, latency, contribution | provider contract/probe/ablation tests | 部分实现 |
| 数据冻结、分层学习与模型回退 | 同源分组后切分训练/验证/留出集，按类别保留全局先验 | preference dataset/version registry | split seed, strata, min samples | holdout accuracy, confidence interval | split/replay/version tests | 已实现 |
| 工具、导出、整数倍预览、图纸、色号、透明边缘、诊断 | 输出材料表、网格预览、模型来源和阶段诊断 | demo/export | preview/export options | export validity | demo/E2E | 已实现 |

## 真实评测证据

- 冻结集：64 张，人物、宠物、插画、物件四类；8 条路线共 512 条记录，生成错误 0。
- `mvp-auto-quality`：总分均值 0.657，剪影 0.849，像素簇 0.916，制作易用 0.891，平均颜色数 5.16。
- `a0-nearest`：总分均值 0.561，剪影 0.751，像素簇 0.697，制作易用 0.717，平均颜色数 9.02。
- 真实 BiRefNet：512×325 输入，健康状态 ready，分析响应 200，返回主体蒙版、语义区、重要性图、建议裁剪和模型溯源。
- 视觉模型范围：BiRefNet、Grounded-SAM2、MMPose AP-10K、OpenCLIP 与 DINOv2 已具备本地 Provider 或 sidecar；OpenCLIP 已使用逐实例 mask 与关键点视图，DINOv2 真实区域证据仍在接线。SAM 3、DINOv3 与 MYOS 进入许可隔离的实验路线。
- 宠物 `v13`：6 张真实图、每张 4 个候选；灰度侧脸犬的青绿杂色清零，侧脸关键点覆盖眼、口鼻、耳尖、上下颌、尾尖和脚掌。
- 内置视觉学习：36 条 PreferenceRecord V2；冻结留出集 48 个成对比较，准确率 0.500 → 0.521，log loss 0.7081 → 0.7057。
