# 像素画参考资料

保留 511 条结构化来源记录及技巧手册，用于查找五官、轮廓、配色和纹理参考。当前实现和待办统一维护在[架构](../architecture.md)与[产品计划](../plans/contours-features-editing-perler-123-plan.md)，本目录不再复制实现清单或完成报告。

| 文件 | 用途 |
| --- | --- |
| [技巧手册](pixel-art-techniques-handbook.md) | 中文美术技巧与来源引用 |
| [逐源记录](close-readings.jsonl) | 原文锚点、技巧、步骤和拼豆映射 |
| [来源索引](source-index.csv) | 作者、URL、主题及来源筛选 |
| [记录格式](record.schema.json) | JSON Schema |

记录基于正文、完整字幕、官方页面或 README；同 URL 去重，转载优先保留原始发布页。A 级为作者教程、官方文档及 Lospec 收录且有完整字幕的视频；B 级为其他完整教程、主题视频与方法明确的仓库说明。

`techniques`、`workflow_steps`、`anchors` 保留来源表达；`failure_modes` 中标记“方法归纳”的内容及 `bead_mapping` 是整理时的推导。字幕可能存在误识别，关键规则须回查原文；资料条数不代表已实现能力或可用于模型训练的数据量。
