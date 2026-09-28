# 实现梳理与剪枝检查

检查日期：2026-09-28。基于当前受控源码、入口引用、TypeScript 编译检查和既有测试；未把未启动的模型、仅有单测的公开接口或历史资料直接判作死代码。

结论：主生成流程已有清晰的规划阶段，优先收敛旧算法残留、评测与产品的证据差异、入口职责和文档。大规模删除模型服务或基线算法缺乏依据。

## 实现分层

| 层 | 当前职责 | 判断 |
|---|---|---|
| `packages/pattern-core` | 形状/画布、五官、结构、明暗、材料配色、轮廓、精修、评分与适配 | 产品主干；保留，逐步拆分流程编排 |
| `material-palettes` / `pattern-api-contracts` / `wechat-client` | 色卡、共享协议、微信适配 | 职责明确，保留 |
| `services/pattern-api` | 身份、文件、任务 Worker、SQLite、结果和导出 | 小程序产品入口，保留 |
| `apps/demo` / `scripts/demo-ai-api.mjs` | 浏览器生成、分析编辑、候选查看及内部评测 UI | 有实际入口；界面编排过于集中 |
| `services/ai-gateway` / 5 个 Python sidecar | 统一模型合同；分割、姿态、提案、视觉评分 | 能力不同，不能按目录数量简单合并或删除 |
| `tools/*-gate` / `tools/auto-eval` | 不同评测协议、候选生产、偏好记录 | 保留质量门禁；优先修正证据路线差异 |

运行关系和当前算法阶段统一见[架构文档](architecture.md)。历史验收状态由[历史交付基线](roadmap.md)维护，本期 P0–P10 排期统一从[计划入口](plans/README.md)进入。

## 本次已剪枝

| 位置 | 整理内容 | 依据 |
|---|---|---|
| `pattern-core/src/structure.ts` | 删除 `designRegionValues`、专属 `hueBucket`、`quantile` | 当前源码与测试均无引用，两个包导出入口也未公开；新主流程已使用 Lab 明暗规划 |
| `ai-gateway/src/segmentation.ts` | 删除 `rectangularMask`、未读的图片参数和中转变量 | 几何蒙版旧残留；模型分割路径不使用 |
| `pipeline.ts`、`pet-analysis.ts`、`shape.ts`、`topology-metrics.ts` | 删除未读的内部参数并同步调用方 | 编译器确认未使用；不修改计算公式或公开签名 |
| `pipeline.ts`、API server、Demo、auto-eval | 清理未使用导入 | TypeScript 检查及 JavaScript 标识符引用扫描后逐项核实 |
| 根 `tsconfig.json` | 开启 `noUnusedLocals` / `noUnusedParameters` | 通过现有 build/typecheck/test 持续检查 TypeScript；不额外引入依赖 |
| `material-palettes/test/palettes.test.mjs` | 将完整色库索引测试与 MARD 自动填色策略分开 | 旧断言要求 H7 原样自动填色，与现行策略冲突；保留 291 色逐项索引验证，并验证 A0/A1/MVP 都排除 H7 |
| README、架构、本期计划 | 更新当前入口和流程，标明历史检查的时间边界 | 避免将旧实现描述误认为当前行为 |

公开导出、生成参数、质量门槛、输出格式和算法版本保持一致。JavaScript 引用扫描只是人工审查辅助；新增编译选项不能发现所有未使用导出或覆盖 `.mjs` 文件。

## 后续收敛优先级

### 1. 优先迁移离线评测的旧宠物几何证据

证据：[`mergeAnalysis`](../tools/auto-eval/src/candidate-runner.mjs) 仍调用 `inferPetInstances`，生成几何脸区、身体区域和关键点；`resolvePetSampleAnalysis` 在未配置模型或失败时返回这一 baseline，在模型成功时也将它与模型证据融合。正式 Demo/Gateway 已停止自动几何补画。

影响：离线候选的输入可能含正式产品没有的几何证据，不能直接把该路线的评测结果视作现行神经蒙版路线的质量结论。

建议：将旧几何路线显式定位为历史对照，产品质量评测改用同一模型分析结果或冻结的模型证据；记录缺失/失败，保留人工修正。迁移数据、测试和调用方后，再决定将约 2,000 行 `pet-analysis.ts` 移至评测包或删除。不能先删除仍在调用的推断函数。

### 2. 缩小主流程与页面的职责

- [`pipeline.ts`](../packages/pattern-core/src/pipeline.ts) 约 3,000 行，同时承担请求校验、身份计算、单候选生成、特征可见度、评分和搜索编排。优先提取请求规范化与候选评分两个边界；保持候选顺序、生成身份、缓存、调度让步和输出不变。移动代码前后用现有 golden、合同与性能测试对照。
- [`apps/demo/index.html`](../apps/demo/index.html) 约 2,800 行，混合样式、DOM、生成状态、模型路线和 mask-gate/偏好 UI。先把脚本和样式移至同目录模块，再将 mask-gate 会话编排归入独立控制器；复用现有 editor/runtime 模块，保持 UI 和 E2E 契约。

这两项的主要收益是降低后续修改的耦合度，不保证减少算法执行时间。无需为了减少行数同时改写算法。

### 3. 给公开兼容接口制定退出条件

- `enrichPetGeometryAnalysis` 当前仓库只见公开导出及其测试；`searchFeaturePairs` 由 experimental 入口导出并有独立测试，主流程已用 `searchFaceFeatureGroup` 联合搜索。它们是退役候选，但不能仅凭生产入口不调用就直接删除公开接口。
- `index.ts` 与 `experimental.ts` 共用 110 个导出名称（包含类型），入口边界含混。建议明确稳定生成、规划实验、偏好学习三个使用范围，迁移 import 后再收窄导出；重复 re-export 不等于存在两套计算实现。
- MediaPipe 人像模块是现成映射与注入接口，没有接上默认真实推理。保留在适配层并标注状态；不能据此宣称已经具备完整人物分析链路。

## 暂不值得剪掉的部分

- **A0/A1 基线、Fast/Quality、24/291 色卡**：已有明确的对照、性能或用户用途。
- **两个轮廓模块**：主流程用 `contour-planner`，公开 `buildValuePlan` 仍支持 `outline-planner`；后者有调用与测试，不能按名称相近直接合并。
- **偏好 V1/V2**：Demo 仍直接调用 Bradley–Terry，V2 处理结构化记录与学习。旧记录迁移也有实际兼容职责。
- **三个 gate 工具**：协议、数据与判定不同。`cli-path.mjs` 的几行路径处理虽相似，但单独增加共享包的收益很小；应在更大范围的工具重构时处理。
- **sidecar 和本地缓存/备份**：前者有独立可选调用方，后者已被 Git 忽略。磁盘空间清理与产品源码剪枝是不同工作，本次不删模型权重、私有样本或恢复备份。

## 验证记录

- `pnpm test`：通过，合计 741 项，包含完整构建、核心 golden/算法/性能、Gateway、API/SDK、色卡、gate、auto-eval 和 Demo 单元/集成测试。
- `pnpm typecheck`：通过，包含微信小程序；所有 TypeScript 项目启用未使用项检查。
- `pnpm exec playwright test apps/demo/workbench.e2e.mjs --grep "generates a refined pattern"`：1 项通过，完成浏览器生成及规划诊断检查；本次未重跑全部 E2E。
- 修改文档的本地链接、修改 JavaScript 的未使用导入复查、`git diff --check`：通过。

本机日志：`output/implementation-pruning-tests.log`、`output/implementation-pruning-typecheck.log`、`output/implementation-pruning-e2e.log`。首次测试受沙箱子进程限制，获准后在沙箱外重跑；随后发现并修正上述 H7 旧测试断言，最终完整测试通过。

此次没有改动 Python sidecar、真实模型权重或外部服务配置；自动化结果不能代替真实模型质量验收。
