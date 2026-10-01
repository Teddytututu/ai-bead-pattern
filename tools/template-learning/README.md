# 参考图纸读格与历史审核包工具

目录名沿用历史名称。当前用途是清点来源、校准格图、保存模型部件证据和读取人工审核包；没有运行中的规则模板库，也没有已训练的模板或全图网格生成模型。

本目录仍支持 template-learning-v1 历史文件校验。[task-contract.md](task-contract.md)与[evaluation-protocol.md](evaluation-protocol.md)会被 prepare 复制到新运行并计算哈希，不能删除文件后保留失效的准备命令。

## 准备和读格

在远端仓库根目录，使用已配置的 SAM2 环境：

~~~bash
services/sam2-sidecar/.venv/bin/python tools/template-learning/run.py prepare --manifest output/datasets/bead-patterns-2026-09-29/manifest.jsonl --data-root output/datasets/bead-patterns-2026-09-29 --output output/template-learning/new-run
services/sam2-sidecar/.venv/bin/python tools/template-learning/run.py grid-pilot --run output/template-learning/new-run --limit 24
services/sam2-sidecar/.venv/bin/python -m unittest discover -s tools/template-learning/tests -v
~~~

输出必须是新目录；已有冻结文件、预测和人工校正不覆盖。prepare 校验原图并导出候选，训练清单保持空。grid-pilot 的面板提案只覆盖工具支持的方格布局，不代表普遍读格成功。

## 模型证据和人工审核

runtime、group-pilot、preannotate 提供模型烟测、相似组建议和部件预标注。真实推理需先分配 GPU；模型输出不是人工真值。

review.py 的 build 生成旧审核界面，import 将导出记录导入新目录。审核内容包括全图格距与占用、部件框、颜色角色、锚点、可见性和来源关系。白珠、空板、未知和 padding 分开；无法确认时保留 unknown。

历史审核页及其冻结协议作为数据兼容入口保留。新的眼睛目标标注见 [独立标注](../../docs/region-annotation-guide.md)，新的两阶段配对要求见 [训练路线](../../docs/training.md)，不要自动将旧角色矩阵升级为新网格监督。
