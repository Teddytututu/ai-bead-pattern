# 文档目录

文档描述当前代码和明确标记的待实现工作。环境数值以锁文件、启动代码和实际配置为准；样本进度以数据清单及审核库为准。

| 主题 | 入口 |
| --- | --- |
| 系统组成与生成流程 | [架构](architecture.md) |
| 高清图、卡通图与最终网格的任务划分 | [训练路线](training.md) |
| SSH、安装、端口转发、备份 | [远程开发](remote-development.md) |
| 上传、数据保留及服务部署 | [数据处理](privacy.md) |
| HTTP 任务与导出 | [Pattern API](../services/pattern-api/README.md) |
| 手机客户端 | [微信小程序](../apps/wechat-miniapp/README.md) |
| 原图 → 卡通图审核 | [教师审核操作](../apps/teacher-review/README.md) |
| 教师服务、冻结、训练及备份 | [Teacher Loop](../tools/teacher-loop/README.md) |
| 完整格图上的眼睛目标标注 | [训练标注](region-annotation-guide.md) |
| 工作台局部修复契约 | [区域生成 v3](region-generation-v3.md) |
| 实体材料数据 | [色卡目录](../assets/palettes/README.md)、[Perler 来源](perler-123.md) |
| 蒙版交互评测 | [Mask Gate](mask-failure-gate.md) |
| 人像分析评测 | [Vision Gate](vision-gate.md) |
| 参考图纸和历史审核包工具 | [数据集工具](../tools/bead-dataset/README.md)、[读格审核工具](../tools/template-learning/README.md) |

各模型服务的 README 负责其用途、配置和测试，不重复维护全局实施计划。新增能力先更新对应说明；替代流程只保留当前入口。日志、运行报告、模型下载说明和冻结数据中的文档不作为产品使用说明。
