# SDXL 区域生成实验

服务在完整拼豆格图的指定区域生成候选，使用 SDXL Inpainting 及可选 LoRA。它不承担高清图到 256 卡通图的教师审核，也不是 256 到 32／64 的全图网格网络。

请求遵循 [region-generation-v3](../../docs/region-generation-v3.md)。工作台产品入口使用辅助蒙版，独立眼睛标注使用 [训练目标协议](../../docs/region-annotation-guide.md)。

## 运行

在远端仓库根目录：

~~~bash
pnpm sdxl:setup
pnpm sdxl:prefetch
pnpm sdxl:test
pnpm build
~~~

获得 GPU 后设置 CUDA_VISIBLE_DEVICES，再运行 pnpm sdxl:start；pnpm demo:sdxl 联合启动实验 Demo。默认 sidecar 为 127.0.0.1:7117，SDXL_REGION_PORT 可覆盖。Demo 使用 SDXL_REGION_ENDPOINT，实验页面为 /apps/demo/region.html。

固定模型与依赖见 [模型实现](src/sdxl_region_sidecar/engine.py)、pyproject.toml 和 uv.lock。默认 model CPU offload；SDXL_REGION_OFFLOAD=sequential 可切换低显存路径，速度需实测。

## 操作与接口

1. 导入 ≤64×64 完整格图，指定编辑格、锁定格、肤色和 prompt。
2. POST /v1/regions/prepare 确认周边与配色，取得 contextSha256。
3. POST /v1/regions/generate 携带同一请求及指纹，取得 candidate 或 rejected。
4. 人工检查候选后接受／拒绝，可撤销，并导出格图与回放。

输入变化后必须重新 prepare。有效编辑区铺肤色作为条件图底色，范围外和锁定格不变。结构检查能拒绝明显空白、无变化或单色结果，但不能保证眼睛语义正确。

/health 返回服务状态，/v1/regions/example 提供合成样例。错误包括 422 参数／过期上下文、409 忙、503 模型或资源问题。单进程串行推理；网页断线不保证中止已经开始的 GPU 计算。

## Adapter 与测试

服务器用 SDXL_REGION_LORA 指定文件，相邻 adapter.json 保存 baseModel、baseRevision 和 sha256。请求 adapter=configured 才使用它，none 明确停用；浏览器不能指定任意权重路径。

pnpm sdxl:smoke、sdxl:lora-smoke、sdxl:vae-smoke 都需要显式设备和新的输出目录。LoRA 单步烟测是合成诊断，不是质量训练。正式模型是否可用须依据训练产物和独立评测，不能依据脚本存在或健康检查判断。
