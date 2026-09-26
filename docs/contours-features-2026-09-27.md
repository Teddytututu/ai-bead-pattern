# 轮廓与五官模板：首批本地实现

日期：2026-09-27。算法版本：`0.9.0-contours-templates`。历史用户验收结论保持不变；本文记录 P2/P3 新增实现，不代表真实照片质量 gate 已通过。

后续增量：已按用户要求接入现成 Grounded-SAM-2 主体/部件蒙版，移除默认几何补全；新增 `pnpm demo:net`。模型来源、真实联调和边界见[神经蒙版记录](neural-masks-2026-09-27.md)。本文下方“未部署新模型”描述的是首批实现时点。

## 双眼定位的修正

明确取消“双眼等高”和“双眼模板相同”的偏好。联合搜索比较输出相对向量与原图映射后的相对向量，倾斜、竖向旋转和透视都保留原来的位置关系。最终姿态评分也不再奖励两眼面积相等；`symmetryQuality`/`featureSymmetryError` 保留兼容字段名，含义改为原图相对姿态保持，Demo 显示为“姿态保持”。

可见眼睛各自选择尺寸、模板和颜色；显式 `missing`、手动隐藏的部件不生成，只有推断位置的五官也不据此补画。整体人脸置信度不能证明每只眼睛可见。MediaPipe 映射保留各眼原始中心及独立眼框/角度，并利用存在的逐点 visibility/presence；没有这些字段时仍需要识别质量检查或手动隐藏，不能声称已解决自动遮挡判断。

嘴中心、嘴角和上下唇作为一个组件的证据，嘴角不再各画一个嘴。旧 `mouth-left/right` 输入兼容合并，按实例分组。眼、鼻、嘴通过 beam width 24、每组件最多 16 个候选联合落格；填充格与保留底色格不得互相覆盖。模板按 45° 档位旋转，整数剪切避免多颗豆挤到同一格；小网格的旋转仍是近似，输出记录实际角度。

## 轮廓与模板

- 结构算法默认外/内轮廓均开启，独立开关；旧 `outlineMode: off/selective/full` 保留，显式 `contours` 字段优先。A0/A1 采样基线不套用结构模板/描边。
- 外轮廓沿主体蒙版或透明通道落在真实边界带；无主体证据时不制造画框。内轮廓按不同语义区域的主边界单侧落格，不把量化明暗层边界画成线。
- 边界带细化、五官占位/保留格保护、内部线条避让一圈、后处理保护均已接入。线条使用真实材料色号，计入总色数、库存和材料数量。
- 自动线色要求源色 ΔE00 ≤20 且 |ΔL*| ≤20，并优先满足邻域 ΔE00 ≥10；可通过 `contours.colorId` 显式指定当前色卡颜色。预算、库存、来源不足会出现在 `contourPlan.diagnostics`，开关开启不等于所有位置已达到对比目标。
- 原 19 个模板保留，扩展至 **35 个**。新增 2×3、3×2、3×3、3×4、4×3、4×4、5×5 眼睛与鼻/嘴/闭眼模板。宽高是包围盒，不等于豆数；例如 3×3 十字眼占 5 格、4×4 眼占 12 格。
- 大模板由测得的部件尺寸或手动选择启用；缺少尺寸证据时沿用保守小模板，不统一放大所有眼睛。

## 本地演示

```powershell
pnpm demo
# 已构建时快速启动
pnpm demo:quick
# 生成可复查的模板总览与合成对照
node scripts/render-contours-features-demo.mjs
```

打开终端打印的 `/apps/demo/` 地址。默认是结构算法、完整描边，外/内轮廓均勾选。左侧展开“五官定位与模板”，选择已有部件或填新标识，可在原图点选、填写坐标、选择模板、隐藏部件、锁定位置；“应用校正”后点击“生成图纸”。角度使用原图局部部件方向，指定角度时同时填写原图部件宽高。上传新图片会清空之前的手动校正。

手动定位使用原图像素坐标，预览 CSS 缩放和留白会反算；裁剪/contain 映射继续由核心处理。学习/生成提案路线先把手动校正合入原图分析，再随分析投影一次，避免二次缩放。

产物：

- `output/contours-features/template-atlas.svg`、`.png`：模板占位与保留底色格。
- `output/contours-features/pose-contours.svg`、`.png`：轮廓四种开关组合及倾斜、异尺寸、90°、单眼遮挡。
- `output/contours-features/diagnostics.json`：上述合成样例的线条与五官诊断。
- `output/contours-features-demo.png`：浏览器校正流程截图。

这些合成图验证几何与开关行为；不是来自真实照片的识别效果报告。

## HTTP / 微信 SDK

沿用创建任务接口及 `WechatPatternClient.createPatternJob`，新增参数无需新建生成端点：

```json
{
  "imageId": "上传返回的 imageId",
  "paletteId": "mard-291",
  "options": {
    "structure": { "contours": { "external": true, "internal": false } },
    "featureOverrides": [
      { "id": "near-eye", "kind": "eye", "x": 100, "y": 80, "templateId": "eye-open-3x3", "locked": true },
      { "id": "far-eye", "kind": "eye", "x": 160, "y": 95, "templateId": "eye-e1", "locked": true }
    ]
  }
}
```

坐标必须处于上传接口返回的**规范化图片宽高**内；示例坐标仅展示参数形式。最多 32 个手动部件，ID 唯一；`hidden: true` 排除部件，`instanceId`/`featureGroupId` 区分对象；`shape` 可传 `widthPx/heightPx/angleDegrees/expression/anchors`。未知模板、类型不匹配、越界坐标和错误轮廓色会被拒绝。

结果候选新增 `featurePlacements`（实际模板/角度/中心/占格/保留格）及 `contourPlan`（路径、材料色及诊断）。原生微信示例提供两种轮廓开关和结果提示；五官校正目前通过 SDK/API 与浏览器 Demo 使用，原生点选编辑器尚未实现。真实小程序环境仍遵循后续接入安排。

## 自动化验证

- 构建与跨包类型检查通过，小程序页面 TypeScript 检查通过。
- 首轮全量运行：核心 419、Gateway 81、API 8、契约 3、SDK 5、色库 6、评测工具 134 项通过。Demo 单元测试的 1 条旧源码断言更新为“先合并校正、再投影”后，74 项全过。
- 最终定向回归 121 项全过，包括新增的调度一致性与形状坐标投影测试；核心累计覆盖 421 项，各包累计 **732 项**（全量与修复后定向重跑合计，非宣称最后一次 `pnpm test` 单次全绿）。
- 浏览器首轮 19 场景中 12 项通过，定位并修正主线程连续计算及两次生成的总体等待预算后，相关 11 场景全部复测通过，覆盖原 7 个失败及 4 个相关场景。19 个独立场景均有通过记录。
- 合成模板总览与姿态/轮廓对照已渲染并目视检查；真实照片质量 gate 尚未完成。

日志在 `output/contours-features-tests.log`、`contours-features-focused-final.log`、`contours-features-demo-unit-final.log`、`contours-features-e2e.log`、`contours-features-browser-final.log`。最初的失败日志保留，避免把重跑结果混写成首轮结果。

## 来源与实现边界

本地回归还修正了浏览器主线程连续计算造成的蒙版面板显示延迟：Demo 在各候选之间调度一次 UI，核心默认计算方式不变；相同输入的生成 ID 和最终格子已做一致性测试。涉及两次生成的移动端测试分别保留单次生成 30 秒等待、整体 60 秒的预算。

本次 35 个模板均标记为项目自绘 `feature-templates-v2`，没有把网上图片的尺寸猜测登记为已核验模板。

- [Perler All My Family](https://perler.com/blogs/projects/all-my-family)：官方人物拼豆项目，用于题材与小尺寸表达方式调研；本次未取得可可靠逐格核对的图纸 PDF，不声称提取了官方 2×3 等矩阵。
- [Perler Woodland Friends](https://perler.com/blogs/projects/woodland-friends)：官方动物拼豆项目，用于动物部件表达参考，同样未作为逐格模板数据或训练样本收入。
- [MediaPipe Face Mesh 官方连接定义](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py)：核对眼角、眼睑与唇缘索引。眼框和部件角度是本项目根据这些点计算的几何证据，不是模型直接返回的独立遮挡标签。
- [Face Landmarker 官方说明](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)：模型结果能力参考。仓库现有 detector 注入边界得到扩展；本批没有下载/部署新的自动人脸模型服务。

待继续：真实人物/宠物/插画分组 gate、真实点位误差和遮挡指标、检测器到本地服务的可用性验证、交互拖拽与局部重算。当前点选/数值编辑会在下次生成时重算候选。纹理保留、逐格编辑、画布调整、Perler 123 和三色卡训练继续按 P4–P9 推进，本批未提前标记完成。
