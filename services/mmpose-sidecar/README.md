# RTMPose 宠物关键点

服务接收一个或多个宠物框，使用 RTMPose-M AP-10K ONNX 输出每个实例的 17 个关键点。框通常来自 Grounded-SAM-2，实例身份贯穿输入和输出。

模型输入为 N×3×256×256，SimCC 输出为 N×17×512。预处理、权重 SHA-256 和来源见 [contracts.py](src/mmpose_sidecar/contracts.py)，不按旧归档描述改变实际张量尺寸。

## 使用

~~~bash
pnpm mmpose:setup
pnpm mmpose:test
pnpm mmpose:start
~~~

默认 127.0.0.1:7104，MMPOSE_PORT 可覆盖；Demo 使用 MMPOSE_ENDPOINT。MMPOSE_MODEL_PATH 可指定已有 ONNX，MMPOSE_DEVICE=cuda 请求可用的 CUDA provider，并须显式分配 GPU。诊断记录实际 provider。

/health 区分权重缺失、已缓存和已加载；pnpm mmpose:smoke 运行真实推理。关键点不能代替分割掩码或人工标注，当前主生成器不据此套用五官模板。
