# 五官模板学习准备工具（FT0 / FT1）

> **路线更正（2026-09-30）**：当前目录保留旧 v1 运行和接口名称。后续采用[全图条件下的区域生成＋仅训练 adapter](../../docs/plans/bead-facial-template-learning-plan.md)；读格、区域证据、分组和审核记录可复用，模板宽高／角色矩阵训练方案已撤销。新的 [v3 区域生成与审核](../../docs/region-generation-v3.md)已实现，正式 adapter 训练和资格审定仍未完成。不要覆盖旧运行目录；代码／说明哈希变化后的新准备工作另建运行。

已实现离线全图输入／可变尺寸输出契约、清点与240候选、方格校准、三视图神经预标注、相似设计分组建议及人工审核页。**没有训练或生成模型，也没有通过真实图质量 gate。** 用户选择先完成预标注和审核页，人工复核稍后安排；训练清单仍为空。

给标注者的入口：[五官模板标注指南](../../docs/annotation-guide.md)，包含逐步操作、格图参考、颜色角色区别、确认检查表和可复制的辅助prompt。

## 运行

在仓库根目录使用现有 SAM2 虚拟环境，复用已安装的 Pydantic、Pillow、NumPy 和 OpenCV；本工具不下载模型。首次配置环境按 [sidecar 说明](../../services/sam2-sidecar/README.md)。其他 Python 环境的读格依赖见 `requirements.txt`，模型烟测必须使用 sidecar 环境。

```powershell
$ftPython = 'services/sam2-sidecar/.venv/Scripts/python.exe'
$ftRun = 'output/template-learning/ft0-v1'
& $ftPython tools/template-learning/run.py prepare --manifest output/datasets/bead-patterns-2026-09-29/manifest.jsonl --data-root output/datasets/bead-patterns-2026-09-29 --output $ftRun
& $ftPython tools/template-learning/run.py runtime --run $ftRun
& $ftPython tools/template-learning/run.py grid-pilot --run $ftRun --limit 24
& $ftPython -m unittest discover -s tools/template-learning/tests -v
```

POSIX 对应解释器为 `services/sam2-sidecar/.venv/bin/python`。每次实验使用新的输出目录；存在目录、阶段结果或修改后的冻结文件会报错，防止覆盖校正记录。代码或协议变化后重新 prepare，原运行保留。所有产物放在忽略目录，不提交原图或派生图。

`prepare` 只读取有效 manifest，逐张校验 SHA-256 和图像解码，不扫描 originals 目录凑数。来源声明格数、实际像素尺寸、审定格数分别保存；未知格数不从图片大小推断。抽样不足或原图失败保留分母，不自动补足或排除。来源资格继承，只有精确内容哈希／来源分组提示，当前不自动划分开发／封存集。

## 产物与阅读顺序

| 路径（相对运行目录） | 含义 |
| --- | --- |
| `meta/run-config.json`、`artifact-hashes.json` | 配额、预算、随机种子、来源／工具／固定模型代码哈希；初始产物哈希 |
| `meta/task-contract.md`、`evaluation-protocol.md`、`schemas/` | 协议快照与机器可读 schema |
| `meta/inventory-summary.json`、`inventory.jsonl` | 全量完整性、声明范围、训练资格及缺口 |
| `pilot/candidates.jsonl`、`training-manifest.jsonl` | 240张候选及当前为空的训练清单 |
| `meta/runtime.json`、`runtime-*.log` | 模型 revision、缓存哈希、依赖、设备、冷加载、推理结果与错误 |
| `pilot/grid-read/index.html` | 24例原图格点叠图和取样色块的离线浏览页 |
| `pilot/grid-read/views.jsonl`、`calibrations.jsonl` | 全部候选的尝试状态、坐标变换、校准提案和文件哈希 |
| `pilot/grid-read/report.json` | 试验分母和未测指标；不作为 FT1 最终验收 |
| `reports/preparation.json` | prepare 时刻的缺口快照；模型后续状态见 runtime.json |

## 读格的能力边界

自动面板提案仅支持1124×720 Kandi Pad 页面，复用 OpenCV 轮廓测量与来源声明的 W/H，匹配右侧方格框比例。它不检测五官、不生成语义蒙版；语义仍必须走固定 GroundingDINO Tiny + SAM 2.1 Small。未知格数、六角底板、照片及无法确认面板需人工校准，不能强套方格。

环带取样避开珠孔与格线，输出全图 RGB、占用、取样一致比例和格点变换。取样一致比例不是准确率。自动提案的 `emptyRgb=null`，占用全部为 unknown；不能仅按接近白色就删除白珠。预览仍可查看 RGB 重建。

在新运行中提供单独的校准 JSONL：

```powershell
& $ftPython tools/template-learning/run.py grid-pilot --run $ftRun --limit 24 --calibrations output/template-learning/reviewed-calibrations.jsonl
```

格式沿用生成的 calibrations.jsonl：panel为原图像素边界 `[x,y,width,height]`，width/height为完整图案格数，fullPattern=true，layout=square，sourceSha256须一致。人工确认后填reviewer、calibrationStatus和显式emptyRgb。混色采样继续unknown；精确等于空白参考色才标空白。该简化读格只用于清晰渲染图，仍须人工逐格／颜色索引对照，审核校准不等于审定每个像素。大于64格的人工校准可保留原尺寸诊断，不能自动成为模型输入。

## 契约校验

```powershell
& $ftPython tools/template-learning/run.py validate --input input.json --prediction prediction.json --target target.json
```

prediction / target 可各自省略。`contracts.py` 和[契约说明](task-contract.md)定义行优先、全图/padding、预测证据与监督隔离、动态宽高、角色、锚点和硬约束。校验不修改尺寸、不裁剪非法候选；超过64格交回原流程。材料色数在FT5解析角色后校验，本工具不把角色数当成SKU数。

## 当前验证记录

本地批次完整性复查2435/2435通过，来源声明79张≤64格、13张超出、2343张未知；审定范围仍未知，训练资格0。240候选中选24张已有声明格数的图纸生成校准诊断，24张均产出预览、自动接受0、人工金标准0；这24张尚未划为正式FT1开发集。

固定模型在仓库猫图上完成一次GPU主体／部件推理；发现头/嘴缺失警告，运行就绪不代表五官准确。记录模型内部耗时、冷启动墙钟及PyTorch分配显存峰值，均非批处理性能承诺。契约、跨实例归属、标签隔离、矩形padding、白珠／空白、范围外尺寸、原图校验、抽样和不可覆盖行为由单元测试覆盖。

## 预标注与人工审核

当前产物：`output/template-learning/ft1-preannotation-v1/`，审核入口为 `pilot/review/index.html`。可以直接在浏览器打开，或启动只监听本机的静态服务：

```powershell
& $ftPython -m http.server 7116 --bind 127.0.0.1 --directory output/template-learning/ft1-preannotation-v1
# 浏览器打开 http://127.0.0.1:7116/pilot/review/
```

完整新运行（务必使用尚不存在的运行目录）：

```powershell
$ftRun = 'output/template-learning/ft1-new-run'
& $ftPython tools/template-learning/run.py prepare --manifest output/datasets/bead-patterns-2026-09-29/manifest.jsonl --data-root output/datasets/bead-patterns-2026-09-29 --output $ftRun
& $ftPython tools/template-learning/run.py grid-pilot --run $ftRun --limit 24
& $ftPython tools/template-learning/run.py group-pilot --run $ftRun
& $ftPython tools/template-learning/run.py preannotate --run $ftRun --limit 24
& $ftPython tools/template-learning/review.py build --run $ftRun
```

预标注串行处理每张图，单图子进程内复用模型完成原页／面板／还原图三次推理；每张超时300秒，不自动重试。使用已有Tiny+Small，独立眼图直接询问眼，其他图先找主体再调用已有部件分析。不用自写语义分割补漏。像素蒙版、分数、模型版本、原始图、叠图、映射比例和失败原因保存在 `pilot/neural/`。映射到格图用实际坐标变换及固定25%面积阈值；此阈值仅是开发诊断设定。

`group-pilot` 在全量原图上比较感知哈希、镜像及规范化标题／来源提示，产出 `pilot/groups/links.jsonl` 和建议连通组。固定页面裁剪仅供相似性筛查，不冒充完整模型输入。这些建议可能误合并或遗漏身份，不产生已确认独立组和数据切分。

审核页支持：

1. 切换三种分图输入，检查原始预测与警告；选择候选或补一个漏检部件。
2. 修改格框，填充未知角色并逐格修正，设置锚点、左右、可见性；局部操作可撤销。角色没有由分割模型可靠判断，初始保持未知。
3. 明确空白参考色后复核全图占用；未知格未清理时不能确认格图。面板／格数错误须先修改独立校准文件并新建运行，不能在此缩图掩盖。
4. 对照相关图，记录同源／不同源和组名；保留待判断项。来源训练资格单独登记依据，审核标注不等于获得许可。
5. 填审核者并显式确认。暂存支持刷新恢复；通过“导出审核记录／草稿”保存JSON。“载入导出的记录”只接受同一审核包。

同一部件的三视图候选不是三个独立样本。主标签应选择一个合适视图，其余可保留诊断草稿。浏览器记录的活动耗时用于整理操作记录，尚不是控制实验中的人工成本结论。

导出后的记录在新目录导入，不改写原始预测：

```powershell
& $ftPython tools/template-learning/review.py import --run output/template-learning/ft1-preannotation-v1 --reviews path/to/template-reviews.json --output output/template-learning/review-import-01
```

导入校验审核包／原图／格图哈希、人工姓名、尺寸和角色、可见性、关系完整性和资格依据，产出 `reviewed-targets.jsonl`、`sample-decisions.jsonl` 及报告。未确认草稿不能升级为真值，漏检不能标成不存在。读取旧运行作审核仅核验冻结数据和预测，不要求后来增加的审核UI与旧推理工具同版本；审核包另保存自身工具哈希。训练导出仍需独立切分和FT1质量门禁，因此当前导入流程的训练清单保持为空。

### 本轮实测与限制

- 2,435张均完成相似性计算，得到1,862条待审核关联、2,034个建议连通组；这不是已确认独立设计数量。24例审核包带54张关联参考图，240候选各自保留训练资格缺口队列。
- 24张×3视图共72次尝试：64次返回主体／分图结果，8次失败（7次未检测到匹配主体，1次无有效SAM实例）。原页／面板／还原图分别返回24/17/23次结果。
- 一共35个**眼部**候选，仅覆盖6/24张；其中7个投影后无有效格。包含同图不同视图重复，鼻／嘴候选为0。现有分图对这批图纸覆盖不足，不能把运行成功率当作部件召回率，也不能宣布自动预标注达标。
- 25项Python测试通过；浏览器遍历24张的72个视图，验证手动补框、角色编辑与撤销、确认约束、刷新恢复、导出／载入、窄屏布局。浏览器测试使用独立上下文及 `output/tests/`，不计为真实人工审核；导入未审核导出包仍得到0真值、0训练资格。

训练需要可靠标签，但不要求全量从零手工描图。当前路线是模型先预标注，人工确认／校正宽高、角色、遮挡与缺失；独立评测必须有可靠人工真值。仅使用未经核查的伪标签可以运行实验，却不能替代这里的监督与验收口径。本批自动覆盖不足，先完成24例人工金标准、分组和使用范围，再决定半自动补标或改进模型提示；不直接扩批训练。总状态见[专项计划](../../docs/plans/bead-facial-template-learning-plan.md)。
