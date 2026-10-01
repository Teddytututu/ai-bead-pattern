# SSH 远程开发与运行

配置了 .tools/remote/connection.json 的 Windows 副本是入口和备份，Linux 工作树为主。远端保存代码与必要数据，Windows 用 SSH 执行 Bash 并转发页面端口。

## 连接与修改

个人配置放在 Git 忽略目录，使用自己的地址和路径：

~~~json
{
  "destination": "user@host",
  "root": "/persistent/path/image-pindou",
  "identityFile": "C:/Users/you/.ssh/project_key",
  "forwards": [{ "local": 4180, "remote": 4177 }]
}
~~~

~~~powershell
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action status
pwsh -NoProfile -File scripts/dev/remote.ps1 -Command 'pnpm typecheck'
pwsh -NoProfile -File scripts/dev/remote.ps1 -ScriptFile path/to/task.sh
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action tunnel
~~~

-Command 和 -ScriptFile 均在远端根目录加载 remote-env.sh 后执行 Bash。先检查工作树，再使用 -Action pull 做快进拉取。保留并发任务的修改，不强制覆盖。GitHub 认证与 SSH 登录分别配置。

## 安装与启动

以下命令在远端 Bash 的仓库根目录执行：

~~~bash
bash scripts/dev/bootstrap-linux.sh core
source scripts/dev/remote-env.sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium
PORT=4177 pnpm demo:quick
~~~

bootstrap 的 core 安装主线环境，all 安装全部配置的 sidecar 环境。版本由脚本和锁文件固定，Python 依赖按服务隔离。不要通过系统 pip 改造服务器环境。

使用模型前按对应 README 预取权重。共享 GPU 通过当前分配的 CUDA_VISIBLE_DEVICES 或服务 --gpu 参数明确选择；不要照抄别人的 GPU 编号。纯文档、普通单元测试无需启动模型训练。

## 服务与端口

| 服务 | 默认远端端口 | 说明 |
| --- | ---: | --- |
| Demo | 4173 | 建议显式 PORT=4177，避免自动换端口 |
| Pattern API | 7105 | /healthz；产品任务接口 |
| Pixel proposal | 7101 | 可选 img2img 提案 |
| OpenCLIP | 7102 | 视觉相似度 |
| SAM2 | 7103 | 主体与部件分割 |
| MMPose | 7104 | 宠物关键点 |
| DINOv2 | 7105 | 与 Pattern API 默认冲突；同时运行时设置 DINOV2_PORT=7106，并同步 DINOV2_ENDPOINT |
| SDXL region | 7117 | 局部生成实验 |
| Teacher Loop | 7119 | --gpu 必填 |

端口转发后访问本机的 /apps/demo/、/apps/training-annotation/；教师服务在其独立转发端口的根路径。现有 teacher-review.ps1 使用本机 4190，具体以脚本为准。127.0.0.1 只代表当前设备，手机不能直接用它访问电脑。

## 验证、备份与清理

按修改范围运行 pnpm typecheck、pnpm test、pnpm test:e2e；Python 检查使用相应 .venv。模型烟测另行选择设备，正式训练另行确认任务与数据。

在远端提交并推送后，本地只做快进同步；忽略的构建文件不会被 Git 自动更新，需要从远端复制已校验产物或删除过期缓存。不要复制 Windows 虚拟环境到 Linux。

.tools、.venv 或 output/tests 可以链接到个人临时盘。删除前解析真实路径，确认目标归属于本项目；不跟随链接清理外部数据。临时盘不可作为人工标注、冻结快照、图像或 adapter 的唯一副本。

教师备份使用 teacher-review.ps1 的 backup 操作，校验 SHA-256。清理对象是已结束的安装／测试日志和可重建报告；活动服务、进行中的训练任务及冻结审核包不按扩展名批量删除。
