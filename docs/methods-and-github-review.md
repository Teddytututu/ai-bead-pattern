# 可采用方法与 GitHub 项目复核

查询日期：2026-09-03

本文承接 [拼豆生成算法完整调研](algorithm-research.md) 与
[V2 算法升级方案](algorithm-upgrade-v2.md)，集中回答三个工程问题：

1. 哪些方法适合直接进入 AI Gateway 与 `pattern-core`。
2. 哪些仓库适合建立强基线、离线教师或竞品对照。
3. 首轮实验怎样用较小投入验证结构、配色和排序收益。

GitHub 活跃度、Stars 和许可证均为查询日快照。模型权重许可证按官方仓库、模型卡和
发布页单独核对。

## 2026-09-03 实现复核

本轮固定读取核心官方仓库与对应 revision：

| 仓库 | 复核 revision | 许可 | 进入程序的规则 |
|---|---|---|---|
| [facebookresearch/sam2](https://github.com/facebookresearch/sam2) | `2b90b9f5ceec907a1c18123530e92e794ad901a4` | Apache-2.0 | 多蒙版输出同时保留 predicted IoU 与 stability score；提示分割再加入正负点一致度，局部小目标可启用 crop layer 与 m2m refinement。 |
| [IDEA-Research/GroundingDINO](https://github.com/IDEA-Research/GroundingDINO) | `856dde20aee659246248e20734ef9ba5214f5e44` | Apache-2.0 | 类别词使用小写裸类别并以句点分隔；检测框恢复为原图 XYXY，保留分数、文本类别和原始顺序。 |
| [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2) | `dd4c5141b75e4838dd486c64f773c43b4db3a07b` (`v1.0`) | Apache-2.0 | 全部检测框一次送入 SAM 2，`multimask_output=False`，框、标签、分数和 `N x H x W` 蒙版按输入顺序传递；稳定 `pet-*` ID 由项目侧建立。 |
| [open-mmlab/mmpose](https://github.com/open-mmlab/mmpose) | `5408bc76f5b848cf925a0d1857899011d8c5b497` (`v1.3.2`) | Apache-2.0 | AP-10K 固定双眼、鼻、颈、尾根与四肢 17 点；AnimalPose 20 点补充左右耳根。耳尖继续由蒙版曲率、骨架端点和耳根方向融合。 |
| [Tau-J/rtmlib](https://github.com/Tau-J/rtmlib) | `03a1693e59e4f7cd84582c0fb30459b3bf18ad42` (`0.0.16`) | Apache-2.0 | 低层 RTMPose 直接接收现有 XYXY 框；上游按框循环推理，项目 sidecar 负责多框单次 ONNX batch。AP-10K ONNX 使用 256 x 256 输入，官方表 AP 为 72.2。 |
| [facebookresearch/detectron2](https://github.com/facebookresearch/detectron2) | `a2f4a8771ab77e8411c26b27f24f9489a28a2453` | Apache-2.0 | `Instances` 的框、蒙版、类别和分数共享同一实例长度，`pred_masks` 采用 `N x H x W`，索引时所有字段同步。 |
| [mlfoundations/open_clip](https://github.com/mlfoundations/open_clip) | `30573618fc375b12f094ef64cb3a1391cf611c45` (`v3.3.0`) | MIT | 图像和文本特征使用 `normalize=True` 的 L2 归一化向量，原图与候选共享同一图像塔。 |
| [jocpae/clDice](https://github.com/jocpae/clDice) | `47d31a6cc4a8101b1ffe8052994821961e57af9f` | MIT | 用参考骨架落入候选区域的比例与候选骨架落入参考区域的比例计算双向中心线一致度。 |
| [scikit-image/scikit-image](https://github.com/scikit-image/scikit-image) | `ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8` (`v0.26.0`) | BSD-3-Clause | 距离排序骨架化提供稳定中心线；与现有 signed distance 距离场复用。 |
| [jni/skan](https://github.com/jni/skan) | `94ec591f4a2763795b84141d6a85cb6fd0ab6b2a` (`v0.13.1`) | BSD-3-Clause | 骨架转分支图、路径长度和端点到分叉点统计继续作为最细结构尺度依据。 |
| [e-koch/FilFinder](https://github.com/e-koch/FilFinder) | `bbb06edc167d177f61fccf600fb812fdf904ddb6` | MIT | 主干优先的分支修剪保留最长连通路径，弱证据短侧枝按长度、边界和语义重要度联合清理。 |
| [facebookresearch/dinov2](https://github.com/facebookresearch/dinov2) | `7764ea0f912e53c92e82eb78a2a1631e92725fc8` | Apache-2.0 | CLS 与 patch token 分别进入全局身份和局部对应；当前生产默认采用 ViT-S/14。 |
| [facebookresearch/sam3](https://github.com/facebookresearch/sam3) | `660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7` | SAM License | 文本提示可输出全部同类实例的 mask、box 和 score；848M 参数、权重访问和自定义许可决定其先作为实验 Provider。 |
| [facebookresearch/dinov3](https://github.com/facebookresearch/dinov3) | `6876159a11b4df116f30f667f8c9888617df0751` | DINOv3 License | 高分辨率稠密特征用于 dense/sparse matching，与 DINOv2-small 在冻结宠物集做区域身份消融。 |
| [KohakuBlueleaf/PixelOE](https://github.com/KohakuBlueleaf/PixelOE) | `341aa85048338d4d26c62fba23176e2b70d9f61b` | Apache-2.0 | 局部亮度极性、代表色和轮廓宽度用于生成选择性描边候选。 |
| [WuZongWei6/Pixelization](https://github.com/WuZongWei6/Pixelization) | `dc6d3b16f34c0329ac025f36924de6bae85d1490` | 限非商业科研 | MYOS 官方实现支持整数 `cell_size`，安排为离线教师和学习型像素化消融。 |

本轮进入程序的行为：

1. OpenCLIP 的候选质量完整保留在语义、类别分布和宠物类别边际；`confidence` 只描述原图类别证据的熵与峰值，差候选维持低分。
2. 选择性描边只在局部对比、背光侧和身份特征约束附近保留；整块主体重要度降到选择阈值以下，计划描边格在网格精修中保持固定。
3. `off / selective / full` 三档经过完整管线后生成不同实体色号网格，图纸元数据记录采用模式。
4. 多宠评估加入主体组件召回率、最弱实例身份完整率和跨实例碰撞率，并进入自动排序特征。OpenCLIP 头部视图当前仍聚合全部宠物，逐实例身份分数进入下一轮接线。
5. `grounded-sam2-local` 接受类别词或默认宠物类别，将冠词、大小写和句点归一成裸类别；GroundingDINO 使用 `0.35 / 0.25` 检测与文本阈值，类无关 NMS 使用 IoU `0.7`，最多保留 16 个实例。
6. 检测框按分数稳定排序，实例 ID 归一为 `pet-01`、`pet-02`；全部框单批送入 SAM 2，每个实例输出原图尺寸 RLE、类别、检测分、predicted IoU、stability score 与 `${instanceId}:subject` 语义区。主体蒙版和裁剪取全部实例并集。
7. 官方五猫 `cats.png` 实测得到 5 个独立实例：检测分 `0.768-0.807`、SAM predicted IoU `0.957-0.977`、stability `0.989-0.995`；RTX 4060 Laptop GPU 上检测约 `851 ms`，单批分割约 `116 ms`。
8. 逐实例关键点采用 rtmlib RTMPose-m AP-10K，直接复用 GroundingDINO XYXY 框；项目 sidecar 将上游逐框路径改为一次 ONNX batch，并把 17 点绑定到相同实例 ID。官方 AP-10K validation AP 为 `0.722`。
9. 新增 node-weighted clDice：clDice 上游提供双向骨架覆盖；端点权重 `3`、分叉点权重 `2`、节点匹配半径 `1.5` 格、结构总分和附加拓扑诊断均为项目扩展。
10. 普通上传缺少类型提示时，先运行 Grounded-SAM2 宠物检测；检测到实例后将全部框单批交给 RTMPose，再融合 BiRefNet 主体边界。
11. 多宠候选执行三项实例门槛：主体组件召回率至少 `0.88`、最弱实例身份完整率至少 `0.35`、跨实例落格碰撞率最多 `0.12`。

### GitHub 规则到程序行为追踪

| 能力 | 固定来源 | 程序参数 | 量化指标 | 行为测试 | 状态 |
|---|---|---|---|---|---|
| 实例 ID 与字段对齐 | Grounded-SAM-2 `dd4c514...`；Detectron2 `a2f4a87...` | 分数降序、原序号 tie-break、`pet-%02d`、最多 16 个实例 | 实例数量、框/类别/分数/RLE 长度一致、原图尺寸保持 | `services/sam2-sidecar/tests/test_engine.py`、`test_app.py`、`apps/demo/demo-ai-api.test.mjs` | 已实现 |
| 细结构与边界提示 | SAM 2 `2b90b9f...`；Transformers `93c8b7b...` | 提示模式多蒙版选优；批量框单蒙版；mask 阈值 0.5；稳定度阈值 0.45/0.55 | predicted IoU、stability、提示吻合度、粗圈包含度、边界 importance | `services/sam2-sidecar/tests/test_engine.py`、`packages/pattern-core/test/outline-planning.test.ts` | 已实现 |
| 多宠身份视图 | OpenCLIP `3057361...`；AP-10K `5408bc7...` | 归一嵌入；头部视图先验 0.85；证据置信度衰减；`pet-*:subject/pet-face` 与同实例关键点独立裁剪 | subject component recall、weakest identity completeness、cross-instance collision、逐实例语义保持 | `tools/auto-eval/test/openclip-views.test.mjs`、`openclip-candidate-scorer.test.mjs`、`candidate-runner.test.mjs`、`candidate-features.test.mjs` | 已实现：动态实例视图进入 scorer，最弱头部实例控制关键惩罚与覆盖率 |
| 逐实例宠物关键点 | rtmlib `03a1693...`；AP-10K RTMPose-m `7a041aa1` | 输入 256 x 256；复用 GroundingDINO XYXY；全部实例单批推理；关键点绑定稳定实例 ID | 17 点覆盖率、双眼/鼻/尾根完整率、骨架连续度 | `services/mmpose-sidecar` 合同、真实猫图与浏览器上传回归 | 已实现 |
| 中心线拓扑一致度 | clDice `47d31a6...`；scikit-image `ee0a7a3...`；Skan `94ec591...` | 阈值 0.5；端点权重 3；分叉点权重 2；节点半径 1.5 格；语义路径硬约束；全局画布连续度门槛 0.85 | clDice、weighted clDice、端点/分叉点 F1、分支/闭环/组件数量一致度、画布可行性 | `packages/pattern-core/test/topology-metrics.test.ts`、`canvas-planner.test.ts`、`algorithm.test.ts` | 已接入画布规划、候选排序和公开诊断 |

### 中心线拓扑实测

`packages/pattern-core/src/topology-metrics.ts` 复用现有距离场骨架和分支图，输出纯函数诊断。
同一猫轮廓夹具得到下面的差异：

| 候选 | clDice | 端点加权 clDice | 中心线召回 | 加权中心线召回 | 端点召回 | 分叉点召回 |
|---|---:|---:|---:|---:|---:|---:|
| 完整轮廓 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 断尾 | 0.8941 | 0.8793 | 0.8085 | 0.7846 | 0.6667 | 0.6667 |
| 断耳 | 0.9556 | 0.9516 | 0.9149 | 0.9077 | 0.8333 | 1.0000 |

这组指标让尾巴、耳尖等细支路脱离面积 IoU 的遮蔽。`weightedClDice`、`endpointF1` 与
`junctionF1` 已进入 `ShapeDiagnostics`、画布规划和候选排序。

同一结构分别规划到 32、48、64 格时，32 格因硬语义端点路径断开与中心线连续度低于门槛被淘汰，
48 与 64 格通过；尺寸排序最终选择 48 格，在结构完整度与制作成本之间取得更高综合分。

`node-weighted-cldice-v2` 的结构总分采用：weighted clDice `0.55`、端点 F1 `0.15`、
分叉点 F1 `0.10`、分支数一致度 `0.10`、闭环数一致度 `0.05`、组件数一致度 `0.05`。
闭环断口与独立部件丢失已经加入行为测试和公开生成指标。

### 实体 F4 桥接与数字拓扑

中心线拓扑衡量视觉结构，实体桥接衡量每颗豆在四邻接方向上的实际支撑。项目固定采用三套
连接定义：前景 C8 表示对角接触仍属于同一语义结构，背景 H4 追踪负空间与孔洞，成品前景 F4
要求上下左右相接。桥接器只处理已知同一来源组件的结构 link，并在保持 C8 组件、H4 孔洞和
组件 owner 的条件下，以较少新增豆把目标支路连成 F4 组件。

本轮固定的数字拓扑来源如下：

| 来源 | 固定 revision | 许可 | 采用原则 |
|---|---|---|---|
| [scikit-image/scikit-image](https://github.com/scikit-image/scikit-image) | `ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8` | BSD-3-Clause | 距离排序骨架化与局部连通定义作为中心线基线。 |
| [jni/skan](https://github.com/jni/skan) | `94ec591f4a2763795b84141d6a85cb6fd0ab6b2a` | BSD-3-Clause | 将骨架压缩为端点、分叉点和有序支路，支路作为桥接事务单位。 |
| [e-koch/FilFinder](https://github.com/e-koch/FilFinder) | `bbb06edc167d177f61fccf600fb812fdf904ddb6` | MIT | 主干优先修剪与支路长度用于区分身份细线和弱侧枝。 |
| [jocpae/clDice](https://github.com/jocpae/clDice) | `47d31a6cc4a8101b1ffe8052994821961e57af9f` | MIT | 双向中心线覆盖负责语义结构评价，F4 制作连通作为独立指标。 |
| [AlexanderHBerger/Topograph](https://github.com/AlexanderHBerger/Topograph) | `77ca4c4fd5d13e8b94e8337c82552baf07808b2e` | MIT | DIU 空间对应用于核对断链、错误合并与孔洞身份，组件计数和 Euler 数作为辅助诊断。 |
| [DGtal-team/DGtal](https://github.com/DGtal-team/DGtal) | `97414f4b403ee411b691898f761cfea577938723` | LGPL-3.0 | 限定为数字拓扑定义与离线 oracle 参考；生产代码自主实现 `3 x 3`、256 种局部邻域的 simple-point 判定。 |
| [opencv/opencv_contrib](https://github.com/opencv/opencv_contrib) | `17af220dd982eb56d647da56032aaebf2caf374f` | Apache-2.0 | `ximgproc.thinning` 作为骨架与端点诊断的差分 oracle。 |

每颗候选桥豆先执行 simple-point 判定，局部前景 C8 与背景 H4 拓扑同时保持。完整骨架支路采用
事务提交：整条路径通过 owner、孔洞、端点和拓扑检查后一次写入。孔洞使用 witness 身份持续
追踪，组件数与 Euler 数用于发现整体漂移。候选排序依次比较已解决 link 数、F4 组件减少量、
新增豆数、共享桥豆数和脆弱关节点数，优先选择单位新增豆带来更多 F4 连通收益的路径。

当前实现位于 `packages/pattern-core/src/craft-connectivity.ts`，并已接入 `shape.ts`、`pipeline.ts`
和候选制作成本：

| 字段层级 | 当前程序字段 | 含义与公开诊断方向 |
|---|---|---|
| 输入 | `values`、`links[{start,end,componentId}]` | 实体网格与同源结构支路。 |
| 约束输入 | `holeReference`、`componentOwners` | 保留 H4 孔洞 witness，并限制桥豆归属。 |
| 内部结果 | `addedCells`、`fragileBridgeCells`、`bridgeReuseCount` | 新增桥豆、F4 关节点和共享桥豆复用。 |
| 拓扑结果 | `fourConnectedComponentsBefore/After`、`eightConnectedComponentsBefore/After`、`holesBefore/After` | 分开记录制作连通、语义连通与负空间孔洞。 |
| 拒绝诊断 | `rejectedLinks`、`simplePointRejections`、`topologyRejections`、`holeRejections`、`ownerRejections` | 解释支路停留在未解决状态的原因。 |
| `ShapeDiagnostics` | `orthogonalBridgeCells`、`fragileOrthogonalBridgeCells`、`craftComponentsBeforeBridging/AfterBridging` | 进入候选评分、制作成本与调试界面。 |
| 公开字段 | `orthogonalBridgeCells`、`bridgeReuseCount`、`simplePointRejectedCount`、`unresolvedLinks`、`fragileBridgeCells` | 已进入形状诊断、候选评分和制作成本。 |

#### F4 桥接追踪表

| 理念 | 程序原则与模块 | 参数 / 指标 | 行为测试 | 状态 |
|---|---|---|---|---|
| C8 / H4 / F4 分工 | `craft-connectivity.ts` 分别计算前景八连通、背景四连通和成品前景四连通 | C8/F4 组件数、H4 孔洞数、`craftComponentsBeforeBridging/AfterBridging` | `craft-connectivity.test.ts` 的 32/48/64 对角路径、C8 分离组件与 H4 菱形夹具 | 已实现 |
| simple-point 桥豆 | 每颗新增豆检查局部 C8 前景与 H4 背景连通数；DGtal `isSimple` 描述删除点，桥豆添加属于反向拓扑应用 | `simplePointRejectedCount` | C8 组件合并拒绝、孔洞角点选择；256 种局部邻域 oracle 差分进行中 | 已实现，oracle 扩展进行中 |
| 支路事务提交 | `medial-graph.ts` 输出支路，桥接器按完整 path 提交或回滚 | `pathId`、`order`、`closed`、`unresolvedLinks` | link 顺序交换、整支路回滚、闭环与硬端点组合继续扩展 | 已实现 |
| 孔洞身份保持 | `holeReference` 生成 witness，桥豆保持 witness 可达关系；Topograph DIU 的预测/参考交集、并集和前后景组件映射作为严格参考 | witness 距离、孔洞解决/坍缩数、Euler 差 | H4 菱形与单孔洞已覆盖；双孔洞和孔洞身份交换进行中 | 已实现，双孔洞扩展进行中 |
| owner 与语义端点 | `componentOwners` 限制跨主体桥接，硬端点维持所属支路 | `ownerRejections`、端点完整率、跨 owner 冲突数 | 异 owner 角点已覆盖；多主体、硬端点与闭环组合继续扩展 | 已实现 |
| 最少桥豆与共享桥豆 | 候选按 `F4 component reduction / addedCells`、resolved link 数和复用收益排序 | `addedCells`、`bridgeReuseCount`、单位桥豆连通收益 | 正 V 共享桥豆已覆盖；D4 对称、菱形转角和 `5 x 5` 穷举 oracle 进行中 | 已实现，最优性扩展进行中 |
| 脆弱结构与制作成本 | 对新增桥豆运行 F4 关节点诊断，并将脆弱单点计入制作成本 | `fragileBridgeCells`、关节点数、细长结构成本 | 32/48/64 对角路径、幂等测试和真实猫耳尖/尾巴对照 | 已实现 |

### 后续 GitHub 方法队列

| 顺序 | 固定来源 | 进入程序的原理 | 最小验收 | 状态 |
|---:|---|---|---|---|
| 1 | MMPose `5408bc7...` AP-10K + AnimalPose | 同一实例框内联合眼、鼻、耳根、四肢；耳尖由耳根方向、蒙版高曲率点和骨架端点联合定位 | 正脸、侧脸、蹲伏与多猫图的实例绑定、镜像左右点、耳尖方向误差 | AP-10K 已接入，AnimalPose 进入对照实验 |
| 2 | DINOv2 `7764ea0...` | ViT-S/14 输出 CLS 与 patch token；分别比较全局主体、头部、眼鼻、耳朵和花纹 | 同猫跨裁剪高于异猫；删除局部结构时对应分数下降 | Provider 已接入；真实逐实例 mask、脸区、关键点接线与冻结实图评测进行中 |
| 3 | PixelOE `341aa85...` | 局部明度中值与极值决定代表色，按对比极性生成 0/1/2 格轮廓候选 | 亮线、暗线、耳尖和尾巴保持端点；平坦区面积漂移低于 2% | 选择性描边已实现，源图多厚度候选待接入 |
| 4 | Pyxelate `f4a046b...` | Sobel 梯度参与分块采样，目标尺寸保持原图比例和留白 | 对角线召回、透明边缘、16:9/3:4/1:1 比例误差 | 待作为并行采样候选 |
| 5 | TorchMetrics `700261d...` | DISTS、LPIPS、SSIM 分别诊断结构、深特征外观与局部模糊 | 五类扰动排序与冻结留出集收益 | 待离线校准，排序初始权重上限 0.05 |
| 6 | DeepLabCut `2df0f46...` SuperAnimal Quadruped | 39 点角色作为内部 teacher，覆盖耳端、嘴角和上下颌 | 角色映射与离线对照，生产下载清单保持商业许可清晰 | 仅内部研究 teacher |
| 7 | SAM 3 `660a5e9...` | 文本提示直接取得全部同类实例 mask、box 与 score，比较复杂多宠和遮挡分离收益 | 冻结多宠集实例召回、边界分数、显存、延迟和许可清单 | 实验 Provider；访问控制与许可评估进行中 |
| 8 | DINOv3 `6876159...` | 高分辨率稠密特征承担局部身份和对应，DINOv2-small 保持生产基线 | 同猫局部匹配、五官错位敏感度、显存和 P95 延迟 | 冻结宠物集消融进行中 |
| 9 | MYOS 官方实现 `dc6d3b1...` | 整数 `cell_size` 生成学习型 cell-controllable 像素化提案，再进入实体色板与制作约束 | 网格尺寸一致、身份关键点保持、许可隔离、候选变化 | 仅非商业离线教师与消融 |

### 小目标、弱蒙版与多裁剪补充

本轮继续读取上游仓库的实际源码、默认参数与示例，将远景宠物、多实例绑定、耳尖和尾尖、
等比主体尺度整理成可直接施工的规则。

| 官方来源 | 固定 revision / 版本 | 许可 | 采用原则 |
|---|---|---|---|
| [obss/sahi](https://github.com/obss/sahi) | `db1a073a32e321f53ed8a6f9ed262861199a9269` (`0.12.6`) | MIT | 切片重叠 `0.2`，同时保留整图预测，跨片合并采用类别感知 `GREEDYNMM + IOS 0.5`。 |
| [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2) | `b7a9c29f196edff0eb54dbe14588d7ae5e3dde28` | Apache-2.0 | 官方高分辨率示例采用 `480 x 480`、重叠 `0.2`、框阈值 `0.2`、NMS IoU `0.8`，用于密集小目标对照。 |
| [facebookresearch/sam2](https://github.com/facebookresearch/sam2) | `2b90b9f5ceec907a1c18123530e92e794ad901a4` | Apache-2.0 | 自动蒙版默认 predicted IoU `0.8`、stability `0.95`、NMS `0.7`；含 crop layers、多蒙版和 `use_m2m` 单步精修。 |
| [jwagner/smartcrop.js](https://github.com/jwagner/smartcrop.js) | `0e207ed910625f91b07d35865c71a9621a63ebdb` (`2.0.5`) | MIT | 多尺度裁剪按 detail、skin、saturation、语义 boost、边缘惩罚和三分构图共同评分。 |
| [open-mmlab/mmpose](https://github.com/open-mmlab/mmpose) | `5408bc76f5b848cf925a0d1857899011d8c5b497` (`v1.3.2`) | Apache-2.0 | AP-10K RTMPose-M 提供 17 点；AnimalPose HRNet-W32 提供 20 点并补充左右耳根。 |
| [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | `ebcc0bc8ec7fe919cec829f2dea656b3078acddc` | MIT | SAM 2 决定实例归属，BiRefNet 在实例边界窄带修正毛发、耳尖和半透明边缘。 |
| [hustvl/ViTMatte](https://github.com/hustvl/ViTMatte) | `8cd7ef068380977c3962c4cb733cb1fe7f2241a5` | MIT | 腐蚀与膨胀形成 trimap，连续 alpha 用于大图毛发和透明边缘实验。 |
| [facebookresearch/dinov2](https://github.com/facebookresearch/dinov2) | `7764ea0f912e53c92e82eb78a2a1631e92725fc8` | Apache-2.0 | CLS token 负责全局主体，patch token 负责逐实例脸部、眼鼻、耳朵和花纹对应。 |
| [sedthh/pyxelate](https://github.com/sedthh/pyxelate) | `f4a046b8` | MIT | Sobel 小块内按梯度加权选择代表色，单边目标尺寸保持原图比例；默认 Sobel `3`、depth `1`、alpha `0.6`。 |
| [google/or-tools](https://github.com/google/or-tools) | `551ad10d94835c99e5e1e684500d3db398c0e345` (`v9.15`) | Apache-2.0 | `NoOverlap2D` 作为多实例重排的离线最优对照，生产候选先枚举横排、竖排、主次和 `2 x 2` 模板。 |

#### 条件切片与稳定实例身份

1. 整图检测始终进入候选池。图像长边达到 `1600 px`，并满足以下任一条件时追加切片：
   整图实例数为零、最高检测分低于 `0.45`、实例面积低于全图 `6%`、实例短边低于
   `192 px`、高分辨率图中出现多个宠物实例。
2. 首轮固定 `480 x 480 / overlap 0.2` 作为 Grounded-SAM-2 官方对照；本地
   GroundingDINO Tiny 追加 `640 x 640` 与 `800 x 800` 延迟和召回消融。
3. 整图与切片检测先恢复原图 XYXY，再执行类别词归一与类别感知
   `GREEDYNMM + IOS 0.5`；分割后继续按 mask IoU、包含率和中心距离合并重复实例。
4. NMS 后按 `(中心 Y 分带、中心 X、面积降序、类别)` 生成几何稳定 ID。存在上一轮实例时，
   采用 mask IoU、类别和 DINO 局部相似度构成代价，再用匈牙利匹配延续 ID。
5. Provider 公开 `detectionRoute`、`fullFrameCount`、`sliceCount`、切片尺寸和合并数量，
   MMPose 沿同一请求数组和 `instanceId` 回写关键点。

#### 弱蒙版复选与边界融合

1. 首轮框批处理采用单蒙版。predicted IoU 低于 `0.90`、stability 低于 `0.95`、
   边界锚点覆盖低于 `0.80`、耳尖或尾尖硬点缺失时，触发逐实例复选。
2. 复选提示由实例框、三个内部正点和四个外部负点组成；三张蒙版按 predicted IoU、
   stability、锚点覆盖、提示一致度和拓扑完整度排序，胜出 logits 再执行一次 `use_m2m` 精修。
3. SAM 2 保持实例归属；BiRefNet 仅处理实例边界窄带。高分辨率毛发实验由
   BiRefNet 生成边界带，再交给 ViTMatte 输出连续 alpha。
4. AP-10K 承担双眼、鼻、颈、尾根和四肢；AnimalPose 在猫犬框内补充耳根。
   耳尖融合耳根外向扇区中的轮廓高曲率点、骨架端点和 BiRefNet alpha 极值。
   AP-10K 数据与标注采用研究许可范围，相关权重进入 research-only 配置，产品发布前完成许可核验。

#### 最细结构驱动等比构图

1. 最细结构从距离场骨架、端点/分叉点支路、主干优先修剪和稳健横截面取得。
   尺度约束只接收耳尖、尾尖、脚掌、道具端点等语义保护支路，或满足
   `geodesic >= max(2.5 px, 3 x 直径)` 且边界置信度达到 `0.6` 的可靠支路。
2. 每个裁剪与画布候选计算
   `scale = min(fitWidth / cropWidth, fitHeight / cropHeight)`。硬结构要求为：
   `protectedDiameter x scale >= 1 格`、耳根到耳尖至少 `2 格`、双眼至少分离 `1 格`，
   眼、鼻和嘴拥有独立落格。规划器选择满足全部硬结构的最小画布。
3. 构图候选包含全部宠物联合裁剪、逐实例裁剪、头部强化裁剪；语义 boost 覆盖眼、鼻、
   耳尖、尾尖和实例框，边距采用 `5% / 10% / 18%` 三档。
4. 硬点越界、主体组件召回低于 `0.98`、关键点安全边距低于 `1 格`的裁剪直接淘汰。
   所有候选采用统一 letterbox 映射，同步变换蒙版、关键点、语义区和重要性图。
5. Pyxelate 的 `gradient-weighted` 采样只进入边缘与五官窗口；平坦主体区域继续采用
   中位色候选。PixelOE 保持轮廓扩张职责，两条路线分别执行消融。

#### 身份与拓扑验收

| 能力 | 模块 / 接口 | 指标 | 固定回归 |
|---|---|---|---|
| 条件切片 | `sam2-sidecar` tile planner、坐标逆映射、跨片合并 | 实例召回、重复实例率、P95 延迟 | 2400 x 1600 远景双兔、切片边缘猫、五猫图 |
| 弱蒙版复选 | SAM 2 多蒙版、提示分数、m2m 精修 | mask IoU、Boundary F、锚点覆盖、耳尖保持率 | 低稳定度猫耳、背景吞并、强实例单次推理 |
| 稳定 ID | 几何键、匈牙利跨轮匹配 | ID 保持率、关键点绑定准确率 | 候选乱序、分数互换、切片重复、同类双猫 |
| 尺度与裁剪 | `pet-composition`、`canvas-planner`、letterbox | 最弱头部格数、最细结构格数、组件召回、负空间 | 同图 32/48/64、联合与逐实例裁剪、16:9/3:4/1:1 |
| 宠物身份 | AP-10K/AnimalPose、DINOv2 区域视图 | 耳尖命中、鼻眼完整率、空间约束 patch 相似度 | 正脸、侧脸、低头、遮挡、镜像、交换眼耳、删除花纹 |
| 像素拓扑 | PixelOE、Pyxelate、clDice、Topograph DIU | weighted clDice、DIU、孤立格、色带、制作组件数 | 对角耳缘、透明边缘、双孔洞、孔洞身份交换、跨主体桥接 |

施工顺序固定为：条件切片 → 弱蒙版复选 → 几何稳定 ID → 耳根与耳尖融合 →
多裁剪和尺度门槛 → DINOv2 空间身份 → DIU 与真实宠物留出集。每一阶段记录单猫、单犬、
单兔、双实例和五猫集合上的实例召回、关键点完整率、耳尖保持率、weighted clDice、DIU、
身份相似度和 P95 推理时间。

## 2026-09-02 宠物结构与灰度配色复核

本轮读取了三个官方仓库的当前实现与配置：

- [PixelOE](https://github.com/KohakuBlueleaf/PixelOE)，Apache-2.0。采用局部对比引导、
  亮度通道细节选择、色度通道中值统计和轮廓扩张思路。
- [MMPose](https://github.com/open-mmlab/mmpose)，Apache-2.0。AP-10K 配置明确提供双眼、
  鼻、颈部、尾根和四肢关键点。
- [DeepLabCut](https://github.com/DeepLabCut/DeepLabCut)，LGPL-3.0。SuperAnimal Quadruped
  提供面向侧视四足动物的检测、裁剪和姿态估计流程。

进入程序的行为：

1. 宠物侧脸判断联合主体长宽比、口鼻突出量和左右方向证据；侧脸使用单眼、单耳、口鼻、
   上下颌、尾尖和前后脚掌锚点，裁剪覆盖完整主体。
2. `cell-aware` 采样用局部中位色度配合高对比亮度，灰度照片中的孤立彩色噪声失去放大路径。
3. `PalettePlan` 对 `Lab chroma < 8` 的角色限制候选材料色 `chroma <= 12`，明暗台阶保持中性。
4. 耳尖角色直接从低明度轮廓色中选色，单格原始量化色仅供普通特征参考。

真实宠物集 `v13` 共 6 张、每张 4 个候选。灰度侧脸犬的青绿耳部杂色已经清除，猫、狗、兔
类别均能读出。侧脸犬仍存在颈部与前腿合并导致的比例问题，下一轮以姿态骨架和身体分区为主。

## 2026-09-03 SAM 2 粗圈与宠物关键点复核

本轮按固定提交读取了 Meta SAM 2、Transformers SAM 2 与 MMPose AP-10K 的官方源码和示例。

- Meta SAM 2 `2b90b9f5ceec907a1c18123530e92e794ad901a4` 将单点等含义模糊的提示交给
  `multimask_output=True`，再用模型预测质量分选出单张蒙版；框与多点可共同描述同一对象，
  前一轮低分辨率 mask logits 可配合新增正负点继续细化。
- Transformers `v5.16.1` 的实际源码提交为
  `93c8b7b485963a10800c91f55304db6be211c2bd`。处理器按原图尺寸归一化点和 XYXY 框，
  模型输出三张 mask 与对应 IoU 预测，并将结果恢复到原图宽高。
- MMPose `v1.3.2` 的 AP-10K 数据定义包含双眼、鼻、颈部、尾根和四肢 17 点；耳尖、
  耳根与尾尖仍由主体轮廓、头部区域和连通路径推断，并标记为 `inferred`。

进入程序的行为：

1. 用户粗圈先压缩到 64 点以内，再转换为 XYXY 框、圈内高间距正点和圈外负点，完整提示交给
   `sam2-local`。
2. SAM 2.1 Hiera Small 输出多张候选蒙版，按预测 IoU、阈值稳定度、正负点吻合度和粗圈包含度
   选择主体；模型输出保持实心蒙版，边界概率生成结构重要性图。
3. COCO uncompressed RLE 保存蒙版，Gateway 校验原图尺寸、模型版本、权重版本、响应大小和实例
   身份；浏览器确认后保留模型蒙版作为后续增补与擦除的基准。
4. 宠物眼和鼻可接入 AP-10K 实测锚点；轮廓推断出的耳尖、耳根和尾尖只参与尺度规划与候选评分，
   观测证据充足时才允许修改主体占格。
内置视觉记录累计 36 条，冻结留出集 48 个成对比较上，学习排序准确率由 0.500 提升到
0.521，log loss 由 0.7081 降到 0.7057。

## 已进入产品

- `services/ai-gateway` 已实现 rembg HTTP `SegmentationProvider`，默认模型为
  `birefnet-general-lite`。
- 模型输出已映射为主体软掩码、边界重要度、自动裁剪、分析置信度和模型版本。
- `pattern-core` v0.2.3 已接收这些字段，并增加成功、best-effort、稳定候选 ID、
  分类型特征评估和 V2 合同校验。

下一批实现聚焦 MediaPipe / MMPose 语义锚点与 PIA-lite。OR-Tools、DINOv2、
通用奖励模型继续按实验门槛推进。

## 结论

下一阶段采用下面这套组合，工程收益最高：

```text
主体边界：rembg + BiRefNet-general-lite ONNX
人物语义：MediaPipe Face Landmarker + SelfieMulticlass
宠物锚点：MMPose RTMPose-m / AP-10K
交互修正：SAM 2.1 small
结构基线：AlexandreBinninger/pixelization 的 PIA 实现
生产结构：OpenCV / scikit-image + 自研 PIA-lite
区域明暗：语义区域 + 稳健分位数 + 二至三档 ShadeRamp
色板规划：Colour + OR-Tools / SciPy MILP
网格修复：现有确定性局部搜索 + 小窗口 CP-SAT
质量诊断：TorchMetrics / PIQ 中的 LPIPS、SSIM、MS-SSIM
偏好排序：规则分 → Bradley-Terry → LightGBM / XGBoost
视觉特征：DINOv2-small，进入偏好数据形成后的排序阶段
```

三项新增判断：

- `rembg` 已经封装 BiRefNet、IS-Net、U²-Net 与 ONNX Runtime，适合快速建立统一分割适配器。
- 新发布的 Rust 仓库 `AlexandreBinninger/pixelization` 提供 MIT 许可的 PIA 实现，适合作为结构强基线。
- 通用图像奖励模型主要面向文生图。拼豆排序先使用项目指标与成对选择，随后加入 DINOv2 特征。

## 方法在系统中的位置

```text
Image
  |
  v
AI Gateway
  |- MediaPipe: 人脸点、头发、皮肤、衣服、配饰
  |- BiRefNet: 主体 mask 与边界置信度
  |- MMPose: 宠物眼、鼻、颈部、四肢锚点
  `- SAM 2: 用户点击或框选后的 mask 修正
  |
  v
ImageAnalysis / UnderstandingResult
  |
  v
pattern-core
  |- CanvasPlan / FeatureBudget
  |- StructurePlan / PIA-lite
  |- ValuePlan / ShadeRamp
  |- PalettePlan / CP-SAT or MILP
  |- ClusterRefiner / local search
  `- CandidateEvaluation / pairwise ranker
```

## 1. 主体、人物与宠物理解

### 1.1 BiRefNet 作为主体边界主模型

[BiRefNet](https://github.com/ZhengPeng7/BiRefNet) 采用全局定位与细节重建两部分，梯度参考
专门服务于细边界。官方仓库提供 MIT 代码与权重、ONNX 转换、动态分辨率模型、肖像模型、
通用模型和轻量模型。标准模型在官方 RTX 4090 测试中达到 1024×1024、FP16 17 FPS、
约 3.45 GB 显存。GitHub Release 中的通用轻量 ONNX 约 224 MB，适合首轮服务端接入。

[rembg](https://github.com/danielgatis/rembg) 已提供 `birefnet-general-lite`、
`birefnet-general`、`birefnet-portrait`、`birefnet-dis` 等模型入口，并支持 Python 库、
CLI、HTTP 服务和 Docker。首轮实验直接通过 rembg 建立 `SegmentationProvider`，验证完成后
再决定是否抽出独立 ONNX Runtime 服务。

推荐模型顺序：

| 模型 | 用途 | 首轮位置 |
|---|---|---|
| `birefnet-general-lite` | 通用人物、宠物、物体 | 默认主体 mask |
| `birefnet-portrait` | 半身与头像 | 人像专项候选 |
| `birefnet-general` | 边界质量上限 | 离线质量对照 |
| `BiRefNet_dynamic` | 任意输入分辨率 | 第二轮质量候选 |

### 1.2 MediaPipe 继续负责人像语义

[MediaPipe](https://github.com/google-ai-edge/mediapipe) 保持人物首选。Face Landmarker
提供五官与脸型锚点，SelfieMulticlass 提供头发、脸部皮肤、身体皮肤、衣服和配饰区域。
BiRefNet 提供主体外边界，MediaPipe 提供主体内部语义，两者输出融合成统一
`UnderstandingResult`。

融合规则建议：

```text
foreground = BiRefNet mask
face / hair / skin / clothes = MediaPipe semantic masks ∩ foreground
landmark confidence = Face Landmarker confidence
boundary confidence = BiRefNet gradient confidence
```

### 1.3 MMPose 负责人宠物锚点

[MMPose](https://github.com/open-mmlab/mmpose) 的 RTMPose / AP-10K 配置提供双眼、鼻子、
颈部、尾根和四肢锚点。BiRefNet 负责毛发外边界，RTMPose 负责姿态与脸部局部坐标，耳朵
继续由轮廓高曲率、对称关系和头部颜色区域联合提取。

### 1.4 SAM 2 进入交互修正

[SAM 2](https://github.com/facebookresearch/sam2) 采用 Apache-2.0，SAM 2.1 Small 为
46 M 参数。官方速度表给出 84.8 FPS；Tiny 为 91.2 FPS，Small 在 MOSE 与 LVOS
指标更高。它适合处理下面两类操作：

- 用户点击主体，修正自动 mask 选错对象。
- 用户框选头发、耳朵、尾巴等区域，刷新局部边界。

自动首轮继续采用 BiRefNet。SAM 2 的价值集中在用户控制与复杂多主体图片。

### 1.5 研究候选

| 方法 | 能力 | 项目位置 |
|---|---|---|
| [DIS-SAM](https://github.com/Tennine2077/DIS-SAM) | SAM + IS-Net 两阶段精细分割 | 提示式边界研究对照 |
| [LawDIS](https://github.com/XinyuYanTJU/LawDIS) | 语言控制与窗口局部细化 | 离线交互教师 |
| [FlowDIS](https://arxiv.org/abs/2605.05077) | Flow Matching + 文本控制 | 论文跟踪 |
| [DIS](https://github.com/xuebinqin/DIS) | IS-Net 通用分割 | 轻量稳定对照 |
| [MVANet](https://github.com/qianyu-dlut/MVANet) | 多视图精细边界 | 高精度研究对照 |

LawDIS 依赖 Stable Diffusion 2 与专用 checkpoint，部署成本较高。FlowDIS 处于 2026 预印本
阶段。两者适合启发“语言或窗口控制 mask”的产品交互。

## 2. 结构抽象与 PIA-lite

### 2.1 PIA 的现成强基线

[AlexandreBinninger/pixelization](https://github.com/AlexandreBinninger/pixelization) 是
2025 年公开的 Rust 库，采用 MIT 许可，包含 K-Means 与 Pixelated Image Abstraction。
该仓库由 SD-πXL 作者维护，并已经发布 `pixelization` crate。它适合承担三项工作：

1. 生成 PIA 结构基线。
2. 验证超像素映射对眼睛、轮廓和小花纹的收益。
3. 对照自研 PIA-lite 的速度与结构指标。

仓库当前提交集中在首次公开发布阶段，依赖评级设为研究基线；生产路线继续保持自研
TypeScript 核心与可解释阶段合同。

固定 revision `820c527f` 的 Rust 源码当前呈现超像素分配、Laplacian/Bilateral 平滑、
模拟退火和色板优化。README 将 graph cuts 列为方法背景；固定源码的可复现路径集中在前述四类
实现，因此该仓库定位为实验基线。学习型 cell-controllable 路线单独采用 MYOS 官方实现
[WuZongWei6/Pixelization](https://github.com/WuZongWei6/Pixelization/tree/dc6d3b16f34c0329ac025f36924de6bae85d1490)，
其整数 `cell_size` 适合生成结构提案，非商业科研许可将其限制在离线教师与消融实验。

### 2.2 生产结构路线

[OpenCV](https://github.com/opencv/opencv) 与
[scikit-image](https://github.com/scikit-image/scikit-image) 覆盖 Guided/Bilateral Filter、
SLIC、RAG、形态学、连通域和轮廓。生产版 PIA-lite 建议按下面顺序实现：

```text
多尺度边缘保持平滑
  -> SLIC 超像素
  -> 语义隔离
  -> 颜色、边界、重要性联合区域合并
  -> FeatureBudget 分配
  -> 输出格到输入区域的局部映射搜索
  -> 关键锚点回填
```

核心新增变量为 `sourceMapping`。每个输出格记录来源区域、局部位移、语义区域、结构锚点与
置信度，后续 ValuePlan 与 PalettePlan 复用同一结构结果。

### 2.3 边缘模型优先级

| 仓库 | 许可 | 维护快照 | 建议 |
|---|---|---|---|
| [TEED](https://github.com/xavysp/TEED) | MIT | 2023-10 最近推送 | 轻量学习边缘对照 |
| [PiDiNet](https://github.com/hellozhuo/pidinet) | 许可待确认 | 2024-07 最近推送 | 许可证确认后再进入实验 |
| OpenCV Canny / Scharr | Apache-2.0 | 活跃 | 首轮生产方案 |

目标网格只有 32 至 64 格，经典边缘与语义 mask 已能提供稳定约束。学习边缘模型安排在
长毛、透明边缘和复杂背景专项中验证。

## 3. 明暗与区域颜色角色

ValuePlan 继续采用区域级方法：

1. 在每个语义连通区域统计稳健亮度分布。
2. 使用 2 至 3 个分位点形成 `base / light / shadow`。
3. 通过相邻区域对比修正脸、头发、衣服和宠物花纹的亮暗顺序。
4. 将高频纹理压入区域角色，将身份纹理保留为独立小区域。

White-box Cartoonization、intrinsic decomposition、LawDIS 与 SD-πXL 均进入离线教师组。
教师输出负责提出候选，最终颜色仍由真实材料色卡约束。

## 4. 色板规划与实体颜色

### 4.1 推荐求解方式

[Colour](https://github.com/colour-science/colour) 作为 Python 色彩基准，`pattern-core`
继续保留已验证的 CIEDE2000 实现。全局 PalettePlan 分成两个规模：

```text
区域级：20 至 120 个区域 × 24 至 80 个候选豆色
格子级：32² 至 64² 个格 × 区域候选色子集
```

区域级使用 [OR-Tools](https://github.com/google/or-tools) CP-SAT 或
[SciPy](https://github.com/scipy/scipy) MILP：

```text
变量 x[r,c] = 区域 r 是否使用颜色 c
变量 y[c]   = 全图是否启用颜色 c

约束：
  每个区域选择 1 至 k 个角色色
  x[r,c] <= y[c]
  sum(y[c]) <= 材料颜色上限
  硬特征颜色保持可区分

目标：
  重要性加权 DeltaE00
  + 区域明暗顺序代价
  + 相邻区域对比代价
  + 启用色号代价
```

格子级继续使用候选色子集与局部搜索。CP-SAT 集中处理 5×5、7×7 的眼口耳、花纹和轮廓
窗口，能够控制耗时与变量规模。

### 4.2 量化基线

| 仓库 | 许可 | 作用 | 判断 |
|---|---|---|---|
| [RgbQuant.js](https://github.com/leeoniya/RgbQuant.js) | MIT | JavaScript 量化与预定义 palette | 浏览器 A0/A1 基线 |
| [rscolorq](https://github.com/okaneco/rscolorq) | Apache-2.0 | 空间量化与抖动联合优化 | 离线强基线 |
| [image_to_pixel_art_wasm](https://github.com/gametorch/image_to_pixel_art_wasm) | MIT | Rust/WASM K-Means 与固定 palette | 端侧速度对照 |
| [libimagequant](https://github.com/ImageOptim/libimagequant) | GPL-3.0/商业双许可 | 高质量量化 | 内部基准或商业授权 |

rscolorq 强调低色数下的空间量化，适合测试“邻域感知量化”收益。其最近代码推送为 2021 年，
生产依赖优先选用 OpenCV、SciPy 与项目自身实现。

### 4.3 色卡数据来源

[BeadColors](https://github.com/maxcleme/beadcolors) 采用 MIT，提供 MARD、Perler、Hama、
Artkal 等品牌 CSV，适合建立色号目录和导入器测试。仓库 RGB 属于社区整理值。正式色卡继续
维护三层来源：

1. 厂家公开色号与名称。
2. 社区 RGB 参考值与来源记录。
3. 项目实体测量的 `measuredLab`。

## 5. 网格能量与局部修复

现有 `pattern-core` 已具备连通域、孤立格、细条、拓扑和 palette coherence。下一轮增加
两个求解器即可：

### 5.1 小窗口 CP-SAT

眼睛、嘴、耳朵、尾巴尖、衣服标志采用 5×5 或 7×7 窗口。每格只保留 2 至 5 个候选色，
目标包含：

- 原始区域颜色代价。
- 硬特征可见度。
- 左右对称与相对位置。
- 孤立格、细条和阶梯代价。
- 修改格数量。

### 5.2 SciPy maximum flow

SciPy 提供 BSD-3-Clause 的 `scipy.sparse.csgraph.maximum_flow`，可构建二元 graph-cut
实验，并作为 alpha-expansion 的底层求解器候选。容量需要缩放为整数，能量转换与数值范围
进入单元测试。

[PyMaxflow](https://github.com/pmneila/PyMaxflow) 采用 GPL，适合研究验证。
[pydensecrf](https://github.com/lucasb-eyer/pydensecrf) 采用 MIT，最近推送为 2024-03，
C++/Cython 安装成本较高，安排在后续候选。

## 6. 多候选排序

### 6.1 排序升级顺序

| 阶段 | 模型 | 输入 | 适用数据量 |
|---|---|---|---:|
| R0 | 规则加权 | 自动指标 | 0 至 500 对 |
| R1 | Bradley-Terry / 逻辑回归 | 候选指标差值 | 500 至 2,000 对 |
| R2 | LightGBM LambdaRank / XGBoost `rank:pairwise` | 指标、区域统计、参数 | 2,000 至 10,000 对 |
| R3 | DINOv2-small + 小型排序头 | 原图、候选图、局部裁剪、指标 | 10,000 对以上 |

[scikit-learn](https://github.com/scikit-learn/scikit-learn) 的逻辑回归足以实现 R1。
[LightGBM](https://github.com/lightgbm-org/LightGBM) 与
[XGBoost](https://github.com/dmlc/xgboost) 均提供正式排序目标。每张来源图片作为一个 query
group，候选方案在组内排序，训练与测试按来源图片切分。

### 6.2 OpenCLIP 与 DINO 稠密特征分工

[DINOv2](https://github.com/facebookresearch/dinov2) 的代码与通用权重采用 Apache-2.0，
能够输出全局 token 与 patch token。拼豆排序可提取四类特征：

- 原图与候选的全局语义相似度。
- 脸部、宠物头部和身份花纹裁剪相似度。
- 主体边界附近 patch 相似度。
- 候选之间的视觉差异。

[OpenCLIP](https://github.com/mlfoundations/open_clip) 负责类别、语义和文本门控；DINOv2 负责
局部身份与稠密对应。当前 DINOv2 sidecar 已实现 Provider 和四类视图，主体框仍由边框颜色、
图像上半部和局部显著性估算。下一步输入真实逐实例 mask、脸区和关键点，逐宠生成独立视图。

当前 patch 对应采用全对全最大相似度，能够识别局部内容存留，也容易放过五官位置移动。
冻结实图评测将增加关键点相对坐标、局部窗口和左右方向约束，让眼、鼻、耳与花纹在正确位置
获得高分。DINOv3 作为高分辨率稠密特征实验项，与 Apache-2.0 的 DINOv2-small 做同集消融；
生产默认继续采用 DINOv2-small。

### 6.3 感知指标只作诊断特征

[TorchMetrics](https://github.com/Lightning-AI/torchmetrics) 采用 Apache-2.0，包含 LPIPS、
SSIM 与 MS-SSIM。[PIQ](https://github.com/photosynthesis-team/piq) 同样采用 Apache-2.0。
两者适合离线评估与排序特征。

LPIPS 和 SSIM 衡量视觉保真或结构相似。拼豆还包含主动简化与工艺目标，因此它们进入特征
集合，由人类偏好决定最终权重。

[IQA-PyTorch](https://github.com/chaofengc/IQA-PyTorch) 模型覆盖很广，当前代码许可为
PolyForm Noncommercial 1.0.0，适合内部研究。

### 6.4 通用奖励模型的位置

| 模型 | 原始任务 | 项目判断 |
|---|---|---|
| [ImageReward](https://github.com/zai-org/ImageReward) | 文本与生成图偏好 | 离线教师特征 |
| [PickScore](https://github.com/yuvalkirstain/PickScore) | 同提示词生成图比较 | 偏好数据协议参考 |
| [HPSv2](https://github.com/tgxs002/HPSv2) | 文生图人类偏好 | 风格候选诊断 |

这些模型依赖 prompt 与文生图数据分布。它们适合回答“候选是否像描述”，项目排序器还要回答
“五官是否清楚、色号是否协调、图纸是否好拼”。首版保持领域指标与项目成对数据主导。

2026 年的 [LPIFM](https://arxiv.org/abs/2608.01301) 使用同一来源的 A/B/Tie 选择训练
source-conditioned 排序器。该论文面向红外与可见光融合，训练协议与拼豆候选高度相似，
适合借鉴四项设计：同源比较、Tie 标签、完整候选对、来源图片级切分。

## 7. 同类 GitHub 项目

### 7.1 项目快照

| 仓库 | Stars | 最近推送 | 许可 | 可借鉴部分 |
|---|---:|---|---|---|
| [Zippland/perler-beads](https://github.com/Zippland/perler-beads) | 867 | 2026-05 | AGPL-3.0 | 多品牌色板与成熟产品基线 |
| [BeadColors](https://github.com/maxcleme/beadcolors) | 39 | 2026-03 | MIT | 品牌色号目录 |
| [bead-grid-studio](https://github.com/zwhy149/bead-grid-studio) | 1 | 2026-08 | Apache-2.0 | 小线稿连通组件 owner 追踪、单 HTML 交付 |
| [MOSAIBeads](https://github.com/TonyVan123/mosaibeads) | 0 | 2026-08 | MIT | 参数搜索、Pareto 候选、4 MB MobileNet 特征 |
| [pbdx](https://github.com/anantheparty/pbdx) | 0 | 2026-05 | 许可待确认 | Lab/CIEDE2000、抖动与邻域平滑 |
| [fuse-bead-pattern-generator](https://github.com/Steeefanie/fuse-bead-pattern-generator) | 0 | 2026-07 | 许可待确认 | 全局 palette 子集贪心与交换优化 |

### 7.2 开源产品覆盖范围

现有项目已经较好覆盖：

- 品牌色板与色号映射。
- Lab / CIEDE2000 匹配。
- 抖动、孤立格整理和材料统计。
- 手工逐格编辑、网格与导出。
- 少量参数搜索或轻量语义特征。

本项目的差异化继续集中在四处：

1. 人物与宠物锚点驱动的 FeatureBudget。
2. PIA-lite 对网格空间的主动重新分配。
3. 语义区域级 ValuePlan 与真实材料 ShadeRamp。
4. 同源 A/B/Tie 数据训练的领域排序器。

Zippland 的 AGPL 代码适合黑盒竞品对照。bead-grid-studio 与 MOSAIBeads 处于近期首发阶段，
适合吸收测试维度与产品交互，核心算法继续独立实现。

## 8. GitHub 维护与许可证矩阵

| 仓库 | Stars | 最近推送 | 许可 | 分类 |
|---|---:|---|---|---|
| BiRefNet | 4,049 | 2026-07 | MIT | 直接接入 |
| rembg | 24,265 | 2026-08 | MIT | 直接接入 |
| MediaPipe | 36,627 | 2026-08 | Apache-2.0 | 直接接入 |
| MMPose | 7,830 | 2025-08 | Apache-2.0 | 直接接入 |
| SAM 2 | 19,705 | 2026-05 | Apache-2.0 | 交互修正 |
| SAM 3 | 查询日快照 | 2026-03 发布 SAM 3.1 | SAM License，权重需申请 | 实验 Provider |
| OpenCV | 90,454 | 2026-08 | Apache-2.0 | 直接接入 |
| scikit-image | 6,573 | 2026-08 | BSD 系 | 研究与实现参考 |
| Colour | 2,635 | 2026-08 | BSD-3-Clause | 颜色基准 |
| OR-Tools | 13,903 | 2026-08 | Apache-2.0 | 直接接入 |
| SciPy | 14,927 | 2026-08 | BSD-3-Clause | 直接接入 |
| scikit-learn | 66,961 | 2026-08 | BSD-3-Clause | R1 排序器 |
| LightGBM | 18,688 | 2026-08 | MIT | R2 排序器 |
| XGBoost | 28,658 | 2026-08 | Apache-2.0 | R2 排序器 |
| DINOv2 | 13,233 | 2026-06 | Apache-2.0 | R3 视觉特征 |
| DINOv3 | 查询日快照 | 查询日活跃 | DINOv3 License，权重需申请 | 高分辨率稠密特征实验 |
| TorchMetrics | 2,458 | 2026-07 | Apache-2.0 | 质量诊断 |
| PIQ | 1,572 | 2024-05 | Apache-2.0 | 质量诊断对照 |
| Pixelization Rust | 1 | 2025-12 | MIT | PIA 实验基线 |
| MYOS 官方 Pixelization | 查询日快照 | 查询日 revision `dc6d3b1...` | 限非商业科研 | 离线教师与 cell-size 消融 |
| RgbQuant.js | 475 | 2024-01 | MIT | 浏览器量化基线 |
| rscolorq | 75 | 2021-03 | Apache-2.0 | 空间量化基线 |
| libimagequant | 925 | 2026-06 | GPL-3.0/商业 | 授权后接入 |
| IQA-PyTorch | 3,366 | 2026-07 | PolyForm Noncommercial | 内部研究 |
| PyMaxflow | 260 | 2024-11 | GPL | 内部研究 |
| PiDiNet | 620 | 2024-07 | 许可待确认 | 许可确认 |

## 9. 首轮实验

### E10：主体与语义融合

样本使用现有 60 图评估集。

| 路线 | 输出 |
|---|---|
| MediaPipe | 人物内部语义与五官锚点 |
| BiRefNet-general-lite | 通用主体 mask |
| BiRefNet-portrait | 人像专项 mask |
| DIS / IS-Net | 轻量分割对照 |

检查 Boundary F-score、毛发与耳朵保留率、主体误选率、冷启动时间、CPU/GPU P50/P95、
模型常驻内存。首轮通过目标为边界人工偏好胜率达到 65%，GPU P95 增量控制在 2 秒内。

### E11：PIA 与 PIA-lite

选择 20 张最容易丢眼睛、耳朵、发型和花纹的图片，固定 48×48 与 24 色。

```text
A1 当前面积采样
B0 Rust PIA
B1 SLIC + 区域合并
B2 B1 + FeatureBudget
B3 B2 + sourceMapping 局部位移
```

检查关键特征可见率、主体轮廓 Boundary F-score、区域碎片数、孤立格比例和人类偏好。
B3 相对 A1 的关键特征可见率目标提升 10 个百分点，人类偏好胜率目标达到 65%。

### E12：ValuePlan 与 PalettePlan

固定 B3 结构，比较：

```text
C0 当前逐格 Lab
C1 区域二至三档明暗
C2 C1 + 贪心 palette 子集
C3 C1 + OR-Tools / SciPy 区域 palette 优化
```

检查重要性加权 DeltaE00、区域亮暗顺序、相邻区域对比、材料色号数和阴影碎片数。C3 在
同等色号上限下，重要性加权 DeltaE00 目标下降 5%，区域亮暗顺序目标达到 95%。

### E13：ClusterRefiner

在眼口耳、发型转折和宠物花纹处建立 5×5、7×7 小窗口，对比现有局部搜索与 CP-SAT。
检查硬特征保持、修改格数、能量下降、耗时与确定性。每候选局部优化 P95 目标控制在
300 ms，重复运行保持逐格一致。

### E14：成对排序

每张图片保留 4 个候选，共形成 `60 × C(4,2) = 360` 个 A/B/Tie 对。20% 样本重复标注，
训练与测试按来源图片切分。

```text
R0 规则分
R1 Bradley-Terry
R2 LightGBM LambdaRank
R2+DINO DINOv2-small 特征
```

检查三分类准确率、非 Tie 方向准确率、Kendall tau、分图片类型胜率和置信度校准。R1 在
独立图片集上先达到 60% 非 Tie 方向准确率，再进入 R2。

## 10. 实施顺序

| 顺序 | 工作 | 交付 |
|---:|---|---|
| 1 | rembg + BiRefNet adapter | `UnderstandingResult.foreground` |
| 2 | MediaPipe / MMPose 融合 | 人物与宠物 FeatureConstraint |
| 3 | Rust PIA 基线 | 固定评估脚本与结果图 |
| 4 | PIA-lite sourceMapping | `StructurePlan` |
| 5 | 区域 ValuePlan | `ShadeRamp` |
| 6 | OR-Tools / SciPy PalettePlan | 全局材料色板方案 |
| 7 | 小窗口 ClusterRefiner | 五官与轮廓局部修复 |
| 8 | A/B/Tie 采集与 Bradley-Terry | 第一版领域排序器 |

这条顺序优先验证主体、结构和明暗。视觉大模型与通用奖励模型在偏好数据形成后进入，能够
减少早期算力投入和数据域偏差。

## 论文参考

- Zheng, P., Gao, D., Fan, D.-P., et al. (2024). Bilateral Reference for
  High-Resolution Dichotomous Image Segmentation. *CAAI Artificial Intelligence Research*.
  <https://doi.org/10.26599/AIR.2024.9150038>
- Zhang, R., Isola, P., Efros, A. A., Shechtman, E., & Wang, O. (2018). The Unreasonable
  Effectiveness of Deep Features as a Perceptual Metric. *CVPR*.
  <https://doi.org/10.1109/CVPR.2018.00068>
- Kirstain, Y., Levy, O., Matiana, S., et al. (2023). Pick-a-Pic: An Open Dataset of User
  Preferences for Text-to-Image Generation. *NeurIPS*.
  <https://doi.org/10.52202/075280-1594>
- Ding, M., Dong, Y., Li, Q., et al. (2023). ImageReward: Learning and Evaluating Human
  Preferences for Text-to-Image Generation. *NeurIPS*.
  <https://doi.org/10.52202/075280-0700>
- Tirandaz, Z., Foster, D., Romero, J., & Nieves, J. L. (2023). Efficient quantization of
  painting images by relevant colors. *Scientific Reports, 13*.
  <https://doi.org/10.1038/s41598-023-29380-8>
- Oquab, M., Darcet, T., Moutakanni, T., et al. (2023). DINOv2: Learning Robust Visual
  Features without Supervision. <https://arxiv.org/abs/2304.07193>
- Liu, H., Liu, M., Li, P., & Zan, G. (2026). Ranking Image Fusion the Way Humans Do: A
  Learned Pairwise Preference Measure for Infrared-Visible Fusion Assessment.
  <https://arxiv.org/abs/2608.01301>

以上论文在 Scite 中完成题录与 editorial notice 检查，editorial notice 列表为空。
GitHub 项目采用官方仓库、README、LICENSE、Release、模型卡与提交记录核对。
