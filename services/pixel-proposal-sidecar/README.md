# 像素风图像提案实验

服务使用固定 PixelArt Sprite checkpoint 和 SD 1.5 LCM-LoRA，提供 learned-pixelization 与 generative-proposal 两类 img2img 提案。它是 Demo 的可选路线，不是当前独立 SDXL 教师，也不是已训练的第二阶段网格模型。

输入等比放入推理画布，结果缩小后仍需经过 Pattern Core 的网格处理、材料映射及质量检查。工作像素尺寸不等于最终拼豆格数，生成图也可能改变语义。

## 使用

~~~bash
pnpm pixel-proposal:setup
pnpm pixel-proposal:test
pnpm build
pnpm demo:ai
~~~

默认 sidecar 127.0.0.1:7101，PIXEL_PROPOSAL_PORT 可覆盖，Demo 配置 PIXEL_PROPOSAL_ENDPOINT。首次真实生成可能下载固定 revision 权重并占用 GPU，须先明确设备。

FastAPI 接收请求，每个 seed 由独立 worker 执行并校验输出，临时文件在请求后清理。模型配置以服务源码和 uv.lock 为准。提案可用于实验比较，不作为身份、姿态或材料合法性的保证。
