# SDXL 区域生成服务（实验）

当前采用用户确认的流程：**先周边，再蒙版区；蒙版内先铺肤色，保持原有底图逻辑**。现有工作台先生成完整拼豆图，实验页确认周边材料与肤色，再让固定 SDXL Inpainting 模型生成蒙版内细节。基础模型、VAE、文本编码器冻结，只允许 LoRA 参数训练。

## 安装与启动

本机已装配。新机器需要 Python 3.11、uv、CUDA GPU，以及仓库的 Node/pnpm 环境。

~~~powershell
pnpm sdxl:setup
pnpm build
pnpm demo:sdxl
~~~

工作台顶栏点击“局部生成实验”，或访问 /apps/demo/region.html。已有 Demo 可另开终端执行 pnpm sdxl:start。服务默认 127.0.0.1:7117；Demo 经同源 /api/ai/region/* 代理。SDXL_REGION_PORT 与 SDXL_REGION_ENDPOINT 可以分别调整服务与代理地址，必须对齐。demo:sdxl 不启动其他大型 GPU 模型。

固定模型为 [diffusers/stable-diffusion-xl-1.0-inpainting-0.1](https://huggingface.co/diffusers/stable-diffusion-xl-1.0-inpainting-0.1/tree/115134f363124c53c7d878647567d04daf26e41e)，revision 115134f363124c53c7d878647567d04daf26e41e，CreativeML Open RAIL++-M。下载 19 文件共 6,941,223,330 字节，fp16 safetensors 缓存于 .tools/huggingface/pinned/sdxl-inpainting/<revision>/；local-manifest.json 保存逐文件 SHA256。推理只读取本地缓存。

本服务 .venv 与 SAM2 等环境隔离，依赖由 pyproject.toml 和 uv.lock 固定：Torch 2.8.0+cu128、Diffusers 0.35.2、PEFT 0.17.1、Transformers 4.56.2、Accelerate 1.10.1。默认 model CPU offload、SDPA、VAE tiling/slicing；SDXL_REGION_OFFLOAD=sequential 是更慢的低显存选项。

## 操作

1. **完成周边图纸**：从工作台带入或导入完整的 ≤64×64 格图 JSON。实验页不会自动修改原工作台。
2. 涂选可改区、锁定必须保留的格。自动建议两格邻域中最多的材料作为肤色底色，请核对；也可手动指定色号。完整模型输入实时显示肤色底图。
3. 选择“补充局部结构”或“填充与色调协调”，填写区域指令及参数，点击 **1 · 确认周边与配色**。没有完成这步，第二步不可用。
4. 点击 **2 · 填充蒙版区**。蒙版内先铺肤色，再由 SDXL 生成；默认最多尝试三次，通过检查后才提供候选。任何参数、底色、mask 或图纸变化，都需重新确认周边。
5. 检查候选的眼型、表情、高光与配色，填写原因后接受／拒绝。接受可以撤销，材料数会重新计算。
6. 导出当前完整图纸和回放记录。可改区有空格时禁止导出完成图；可导出回放留作草稿。数据只在当前页面，未实现服务端持久化，离开前需导出。

填充包括原先为 -1 的空格，最终每个有效编辑格都必须为合法珠色。范围外原空板和锁定格原样保留；蒙版内“空格且锁定”是冲突，需先解锁。白色珠子不等于空板。新版本不再用灰色挖空图，也不以完整源图替代拼豆周边作为网络输入。

结构模式拦截无变化、透明和四格及以上的单色／低对比编辑区域；色调模式可接受合理的纯色填充。这些规则不是眼睛识别器，形状与语义仍需人工审核。

示例 prompt：

> A flat pixel art face with two matching open eyes. Fill the missing eye on the left side of the image with a dark outline, turquoise iris and one tiny pale highlight, matching the existing right eye. Preserve the surrounding skin tone and expression.

闭眼可写 a gently closed eye, a short dark eyelid, no iris or highlight。有遮挡应明确保留遮挡。指令应反映此图的目标。默认 512、20 步、strength 0.99、CFG 8、seed 42；512/768/1024 是工作像素，不改变最终格数。

## API 与适配器

当前为 [region-generation-v3](../../docs/region-generation-v3.md)，尚未接入产品 API 或微信 SDK。

- GET /health：模型缓存／加载状态与支持的流程。
- GET /v1/regions/example：原创合成缺眼样例，非人工真值。
- POST /v1/regions/prepare：第一步。冻结请求输入、确定周边与肤色色号，返回 contextSha256 及底图／mask 预览。
- POST /v1/regions/generate：第二步。要求携带匹配的 contextSha256；返回 candidate 或 rejected。失败不会返回可接受格图。422 为参数／顺序错误，409 为忙，503 为模型／资源错误。

单进程串行推理；成功后释放空闲 CUDA 缓存。关闭页面、断线或代理 10 分钟超时不会立即停止 GPU 计算。OOM 保留原图，清理失败 pipeline 后下一次重载。不要并行运行多个大型 GPU 测试。

加载评估后的 LoRA：

~~~powershell
$env:SDXL_REGION_LORA='C:\absolute\path\adapter.safetensors'
pnpm sdxl:start
~~~

相邻 adapter.json 必须含 baseModel、baseRevision、sha256。请求 adapter=configured 才启用，none 明确停用；浏览器不能指定文件路径。诊断 adapter 标记 synthetic-diagnostic-only-not-quality-trained，不作为默认模型。

## 测试

输出目录必须是新目录，GPU 试验顺序执行：

~~~powershell
pnpm sdxl:test
pnpm test:demo
pnpm sdxl:smoke --output output/diagnostics/my-skin-512
pnpm sdxl:smoke --working-size 1024 --output output/diagnostics/my-skin-1024
pnpm sdxl:lora-smoke --size 512 --output output/diagnostics/my-lora-step
pnpm sdxl:vae-smoke --output output/diagnostics/my-vae-roundtrip
~~~

smoke 自动先 prepare 再 generate，准备事件不是人工确认。lora-smoke 只在原创合成图做一次 rank-4 更新，不读取待审图库；VAE／LoRA 脚本的监督或往返图保留完整目标，不将铺肤色的输入当作目标。正式数据训练器和质量门禁尚未完成。

启动默认端口服务／Demo 后，可运行 node scripts/dev/check-sdxl-browser.mjs <新输出目录>。默认测试 Demo 地址为 4177，SDXL_DEMO_URL 可调整。检查覆盖先周边后生成、肤色底图、完整填充、接受／撤销与导出。

最新状态见 [流程计划与实测](../../docs/plans/masked-grid-fill-plan.md)；此前的 [首轮 v2 装配记录](../../docs/plans/sdxl-region-implementation-2026-09-30.md)为历史诊断，不代表当前输入流程。
