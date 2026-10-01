# 参考图纸采集与索引

工具维护拼豆参考图纸的来源、内容哈希、分类、离线浏览和索引。版本化 [snapshot](snapshot/)保存固定批次元数据；原图、完整清单、网页快照和 SQLite 位于 Git 忽略的 output/datasets。

固定参考批次登记 2,435 张有效 PNG。该数量是快照记录，不是当前已审定训练样本数。图片像素尺寸不能当作格数，未知格数保持未知，六角或多部件布局需单独确认。

## 使用

在远端已配置 Pillow 的环境执行：

~~~bash
services/sam2-sidecar/.venv/bin/python tools/bead-dataset/index_dataset.py
services/sam2-sidecar/.venv/bin/python tools/bead-dataset/finalize_notes.py
node tools/bead-dataset/validate_gallery.cjs
~~~

这些脚本面向其固定批次路径，需要既有原图、清单和相应采集报告。索引器校验原图哈希，生成 JSON／JSONL、SQLite、联系表和浏览页；它不是训练器。

collect.py 与 expand.py 会联网采集，不在普通检查中运行。公开网页会变化，重新采集不能保证重现固定快照。读取数据以 manifest 为准，原图目录可能保留已排除项。

## 数据含义

snapshot 中的来源审核、使用资格和视觉分类各自独立。当前参考批次不是原插画／卡通图／最终网格的配对训练集；没有审定逐格标签时，图纸截图不能直接成为网格真值。

[读格审核工具](../template-learning/README.md)可产生校准、部件证据和人工记录，但不会自动赋予训练资格。两阶段输入与目标要求见 [训练路线](../../docs/training.md)。

原始图片、作者信息、来源页面和许可记录是数据证据，不作为过期文档或普通日志清理。浏览页生成的 README 属于具体数据包，应随该包保存。
