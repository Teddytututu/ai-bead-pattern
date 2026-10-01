# 开发约定

本仓库以配置的 Linux SSH 工作副本为主。Windows 存在 .tools/remote/connection.json 时，只作为 SSH 入口和备份。

- 首先运行 `pwsh -NoProfile -File scripts/dev/remote.ps1 -Action status`。读取连接配置时不输出凭据。
- 项目读取、修改、构建、测试、模型运行和 Git 提交均在远端执行。remote.ps1 的 -Command 和 -ScriptFile 接收 Bash，并加载 scripts/dev/remote-env.sh。
- 本地可修复 SSH 入口、同步备份；SSH 不可用时不要把项目开发静默转回 Windows。
- 操作前检查远端工作树，保留其他任务的修改。拉取只用 fast-forward，不覆盖未提交文件。
- 按职责维护当前说明；架构见 [docs/architecture.md](docs/architecture.md)，训练边界见 [docs/training.md](docs/training.md)。删除旧文档时同步修复引用。
- 连接信息、密钥、模型缓存、原始数据、运行输出不进入 Git。冻结审核包、来源记录和内容哈希必须保留。
- 代码存入 Git；人工标注、训练成果和必要回放存入持久空间并备份。临时盘只存可重建内容。
- 清理日志前区分活动进程、训练任务、冻结证据和临时验证。不要删除运行中的日志或冻结包的一部分。
- 共享 GPU 必须按当前分配显式选择。安装、单元测试和烟测不代表已获准启动正式数据训练。
- 仅对本次改变运行必要检查；文档修改检查路径、命令和实现一致性，不重复启动 GPU 任务。

安装、端口转发和同步方式见 [远程开发](docs/remote-development.md)。
