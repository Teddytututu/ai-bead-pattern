# SSH 远程开发

项目工作副本、构建、测试和模型推理均在 Linux SSH 服务器运行；本机通过 SSH 执行命令和转发网页端口。服务器地址、用户名、私钥和个人目录配置不提交 Git。

## 首次安装

在自己的持久项目目录克隆仓库后进入 Bash。默认登录 shell 如果是 tcsh，先运行 `bash`，再执行以下命令：

```bash
git clone https://github.com/Teddytututu/ai-bead-pattern.git image-pindou
cd image-pindou
bash scripts/dev/bootstrap-linux.sh all
source scripts/dev/remote-env.sh
pnpm sdxl:prefetch
pnpm sam2:prefetch
pnpm exec playwright install chromium
```

安装固定 Node 24.13.0、pnpm 11.19.0、uv 0.12.19 和 Python 3.11。Node／uv 下载验证官方发布的 SHA-256；JavaScript 按 pnpm lockfile，六个 sidecar 按各自 uv.lock 安装，互相隔离。`core` 参数仅安装当前主线 SDXL 与 SAM2 两个 Python 环境。不会替换系统 Python、pip、CUDA 或其他用户环境。

每次进入工作目录后执行 `source scripts/dev/remote-env.sh`。工具与缓存位于该副本的 `.tools`，虚拟环境位于各服务 `.venv`；默认 CPU 线程数为 4，可显式覆盖。GPU 编号必须按当前分配选择，脚本不预占 GPU。

家目录可能存在 `df`／`quota` 未显示的服务端配额。若安装报 `Disk quota exceeded`，可将 `.tools` 和各服务 `.venv` 放到个人临时盘目录，再用符号链接连接回仓库。根 `node_modules` 保留真实目录；环境脚本将 pnpm store 与 virtual store 放到 `.tools`，以免 pnpm 重建目录时留下断链。先确认目标目录归自己所有，已有目录不能直接覆盖。临时缓存被清理后需要重新建立链接和运行安装脚本；它不能作为标注、代码或训练成果的唯一存储。

## 本机 SSH 入口

PowerShell 7 可使用 `scripts/dev/remote.ps1`。个人配置写在忽略路径 `.tools/remote/connection.json`，格式如下；私钥内容不放入配置：

```json
{
  "destination": "user@host",
  "root": "/persistent/path/image-pindou",
  "identityFile": "C:/Users/you/.ssh/project_key",
  "forwards": [{ "local": 4180, "remote": 4177 }]
}
```

```powershell
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action status
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action pull
pwsh -NoProfile -File scripts/dev/remote.ps1 -Command 'pnpm test'
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action tunnel
```

入口在远端切换到工作目录、加载工具环境并执行 Bash；显式发送 LF，避免 Windows 管道末尾的 CRLF 被 tcsh／Bash 当成命令字符。`-ScriptFile` 可发送本机保存的 Bash 脚本；`tunnel` 保持运行直到关闭。

## 更新与验证

```bash
git status --short
git pull --ff-only
source scripts/dev/remote-env.sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm sdxl:test
pnpm sam2:test
services/sam2-sidecar/.venv/bin/python -m unittest discover -s tools/template-learning/tests -v
```

修改在远端完成，检查后在远端提交和推送；本地副本只作入口或备份，避免两边同时改同一文件。拉取遇到分叉或本地修改时先处理，不强制覆盖。GitHub 写入认证与学校 SSH 登录认证分别配置，学校登录密钥不充当 GitHub 密钥。

## 浏览器访问

远端启动示例（将 GPU 编号替换为当前获分配的设备）：

```bash
source scripts/dev/remote-env.sh
CUDA_VISIBLE_DEVICES=1 PORT=4177 pnpm demo:sdxl
```

本机另开终端建立转发，端口已占用时可换本地端口：

```bash
ssh -N -L 127.0.0.1:4180:127.0.0.1:4177 -L 127.0.0.1:7118:127.0.0.1:7117 user@host
```

访问 `http://127.0.0.1:4180/apps/demo/region.html`。请求通过远端 Demo 的同源代理进入 SDXL。无需把实验服务公开监听到校园网。

## 数据与模型

`.tools`、`.venv`、`output`、`work` 与私有配置不进入 Git。跨机器迁移下载图纸、人工审核包和诊断时保留原路径及 SHA-256，以单独的安全文件传输完成，不通过公共仓库。Windows 虚拟环境不能复制到 Linux 使用，必须从锁文件重建。

现有冻结审核包中的历史绝对路径作为来源记录保留；重跑准备阶段时使用远端路径并建立新的输出目录，不能篡改已有真值或运行哈希。

服务器临时盘若有定期清理策略，只放可重建缓存；数据、标注和 adapter 应放持久项目目录并备份。学校 COMPUTE 容器若禁止运行时联网，应在构建镜像或准备阶段安装依赖、下载模型。正式 LoRA 训练仍以合格目标、独立来源分组和使用资格为前提。
