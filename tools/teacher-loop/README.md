# SDXL 教师闭环

工具处理高清原图到 256×256 卡通中间图，提供生成轮次、A/B 审核、版本化导出、训练快照和 LoRA。它尚未替换产品主生成链路，也不实现第二阶段全图网格网络。

操作人员使用 [教师审核说明](../../apps/teacher-review/README.md)，整体任务划分见 [训练路线](../../docs/training.md)。

## 数据和训练方式

准备脚本构建动物照片及动漫脸输入，并由 manifest 指定实际条目、来源、哈希和 split，不能扫描 images 目录直接训练。编号映射保留旧 ID，避免破坏既有标注。

新轮次生成高分辨率底稿及等比补边的 256×256 预览，两者记录哈希。人工通过预览后，教师 LoRA 使用对应底稿和文字。它是风格训练：原图不是 UNet 的配对条件，固定 Canny 用于推理。

冻结汇总每张输入最新审核决定；最新拒绝撤销旧目标，一张输入最多一个目标。只有 train 项进入训练，validation／test 不进入梯度更新。当前启动门槛为至少 20 个通过的独立 train 输入，不是效果保证。

训练参数、固定基座、种子和 adapter 身份随快照及产物保存。训练完成的 adapter 仍需新轮次与固定验证源比较，不自动作为已合格模型发布。

## 远端运行

在已安装依赖的仓库根目录，按需执行准备步骤：

~~~bash
source scripts/dev/remote-env.sh
services/sam2-sidecar/.venv/bin/python tools/teacher-loop/prepare.py
services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/number_dataset.py
services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/prefetch.py
services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/prefetch-control.py
services/sam2-sidecar/.venv/bin/python tools/teacher-loop/controls.py
~~~

prepare 拒绝覆盖已有 manifest；已有数据时不要重复初始化。使用 server.py --gpu 指定当前获分配的单个 GPU，--port 默认 7119。服务只监听本机，按 GPU 锁协调任务。命令行 worker 的多卡生成分片见下文。

## 保存与恢复

默认数据根目录为 output/teacher-loop，可通过 TEACHER_LOOP_DATA 配置。审核库、历史版本、快照和 exports 应位于持久存储；图像、rounds、adapters 若链接到临时盘，必须另有已校验备份。

~~~powershell
pwsh -NoProfile -File scripts/dev/teacher-review.ps1 -Action tunnel
pwsh -NoProfile -File scripts/dev/teacher-review.ps1 -Action backup -Scope all
~~~

备份脚本校验传输哈希，SQLite 使用一致快照，结果和 adapter 仅打包已完成项。网页下载的数据库备份不包含全部图片。恢复需要数据集、编号映射、图像、数据库、快照及 adapter 相互匹配。

每组导出按范围命名，后台使用内容哈希目录保存版本。合并审核时按 round_id＋item_id 选择较新的 review_version；不能把重复导出当成新样本。

## 验证

~~~bash
services/sdxl-region-sidecar/.venv/bin/python -m unittest discover -s tools/teacher-loop/tests -v
node tools/teacher-loop/tests/browser.mjs
~~~

单元测试使用临时库，浏览器测试使用 mock。tests/gpu_smoke.py 会实际占用 GPU，只做合成诊断，需单独选择设备。训练任务日志、失败清单和审核证据不作为过期普通日志清理。

## 多卡补全同一轮候选

worker 支持 --shard-index 0 到 N-1 与 --shard-count N，按固定交错顺序将输入划成互不重复的分片。每个 worker 使用独立的 job 记录和显式 --gpu。默认分片数 1，与原单卡服务兼容。生成前持有每张图的文件锁；完整结果校验后跳过，保留已标注候选字节。更换并行任务时先停止旧 worker，再将旧 job 标为 cancelled；已完成结果和标注不变。分片仅用于生成，不能用于正式训练。
