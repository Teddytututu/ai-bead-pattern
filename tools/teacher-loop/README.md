# SDXL 教师迭代

网页经 SSH 转发访问 http://127.0.0.1:4190 。这是独立主体卡通化实验，不替换原有 SAM2 或眼睛补全服务。

## 标注与输出

选择卡通风格，同时保持原图主体不失真。检查轮廓、五官、姿态、主要颜色与身份；不要因更卡通而接受换脸、变形或改色。两张都明显失真时全部拒绝。

新轮次内部生成 1024×1024 底稿，标注/导出结果为 256×256，等比缩放、白色补边，不拉伸不裁切。网页可查看高分辨率底稿。LoRA 使用对应已通过预览的底稿，两者均记录哈希。旧校准轮次保持原状。

每轮每完成 25 个不同输入的标注，导出一批 JSONL 到持久目录 output/teacher-loop/exports，并触发浏览器下载。页面保留下载链接；不足 25 张可手动导出。修改不重复计数，已导出批次修改后生成新哈希版本，不覆盖历史。导出包含拒绝项、split、路径/哈希、标注版本；合并时按 round_id + item_id 取最大 review_version。JSONL 不含图片字节，迁移需同时保存图像。

## 训练流程

固定输入 → SDXL + Canny A/B → 人工合格判定 → 冻结 → 风格 LoRA → 下一轮 → 固定验证集比较。

普通 SDXL LoRA 学习目标图和文字，原图不是 UNet 训练条件；原图/目标配对供后续条件模型或手机学生训练。Canny 仅作为固定推理条件，本阶段不训练它。

每次从同一固定基座初始化新 LoRA，汇总每张输入最新人工决定；最新拒绝移除旧目标。一张输入最多一个目标，两张合格时选偏好图，相当取 A。validation/test 永不用于训练，test 保留作最终评估。adapter 完成后标记未评测，由操作人员选择到新轮次。

至少 20 个不同 train 输入通过才能做小规模试验；默认 rank 8、学习率 5e-5、4 epochs、梯度累积 4、1024、BF16、梯度检查点，仅训练 UNet LoRA。20 张是防误启动门槛，不是质量保证。未标注时不启动真实训练。持续低通过率需改进教师或人工制作目标，重复筛选不会凭空产生新能力。

## 数据及限制

- 250 张真实猫狗照片，来自 Oxford-IIIT Pet 的 37 品种，不代表广泛动物。原生短边最低 400，中位数约 498 像素，放大不等于原生高清。
- 250 张合成动漫脸；原图 1024×1024，裁切短边 512–1024。女性角色为主，非均衡脸部数据；保留原图、来源版本、裁切框及检测器哈希。
- 各类别 200 train / 25 validation / 25 test，总计 400 / 50 / 50。感知近似图先分组再划分，不保证身份绝对独立，正式评测仍需身份审查。
- manifest.json 指定实际 500 张，images 中还有备用图，请勿直接按目录训练。visual-qc.json 是输入筛查，不是人工目标标签。
- Oxford 发布页 https://www.robots.ox.ac.uk/~vgg/data/pets/ 声明 CC BY-SA 4.0，原图版权归原作者；https://huggingface.co/datasets/alfredplpl/anime-with-caption-cc0 声明 CC0。这些是发布者许可声明，逐图保留来源。
- 500 张适合工作流和小规模试验，后续需扩展动物类型、角色性别、姿态、画风及独立来源。

## 存储与备份

远端代码、SQLite 标注历史、冻结快照、JSONL 在持久项目目录。当前家目录配额不足，dataset-v1、rounds、adapters 链接到 .tools 运行盘，可能被清理。Windows 已保存输入集，结果和 adapter 在轮次完成后应执行备份，不能仅存运行盘。

Windows：

    pwsh -NoProfile -File scripts/dev/teacher-review.ps1 -Action tunnel
    pwsh -NoProfile -File scripts/dev/teacher-review.ps1 -Action backup -Scope all

备份放在 output/teacher-loop-backups，传输后核验 SHA-256；SQLite 使用一致快照，只打包 A/B 都完成的结果及已完成 adapter。网页“下载标注备份”仅为 SQLite，完整恢复也需要图像归档。原数据、标注和权重不进入 Git。

## 远端运行

先运行 SSH status，再通过 remote.ps1 执行 Bash：

    source scripts/dev/remote-env.sh
    services/sam2-sidecar/.venv/bin/python tools/teacher-loop/prepare.py
    services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/prefetch.py
    services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/prefetch-control.py
    services/sam2-sidecar/.venv/bin/python tools/teacher-loop/controls.py
    services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/server.py --gpu 1 --port 7119

prepare 不覆盖已有 manifest。复用服务锁定环境，不升级系统依赖。GPU 根据分配显式指定，同一服务只跑一个 GPU 任务，localhost 监听。

SDXL 固定 revision 462165984030d82259a11f4367a4eed129e94a7b；Canny 固定 eb115a19a10d14909256db740ed109532ab1483c。每轮固定配置、种子、adapter 哈希；失败生成可继续，完整结果经核验后跳过。

## 测试

    services/sdxl-region-sidecar/.venv/bin/python -m unittest discover -s tools/teacher-loop/tests -v
    node tools/teacher-loop/tests/browser.mjs
    CUDA_VISIBLE_DEVICES=2 services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/tests/gpu_smoke.py

单元测试使用临时库；浏览器 mock 标注写入，不写真实标签；GPU 测试仅用程序生成绿色方块，验证一次优化器更新和 LoRA 保存/读取。真实质量需标注后用留出集评测。
