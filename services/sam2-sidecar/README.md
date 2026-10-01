# Grounded-SAM-2 主体与部件分析

服务使用固定 GroundingDINO Tiny + SAM 2.1 Small，提供自动主体／部件发现和带提示的实例分割。模型身份、revision 与来源记录见 [contracts.py](src/sam2_sidecar/contracts.py)，环境以 pyproject.toml 和 uv.lock 为准。

## 输出

自动路线保留实例类别、检测分数、SAM 分数、原图尺寸 RLE 蒙版及语义区域。请求部件能力时，在主体区域中识别眼、鼻、嘴、耳和身体部件，测量独立位置和局部方向。

缺失检测返回警告，不镜像补另一只眼、不制造几何蒙版、不补画五官。置信度不是已校准准确率，局部方向不等于三维头部姿态。

交互路线接受粗圈、框和正负点，输出候选掩码及选择依据。Gateway 管理超时，sidecar 串行执行模型调用。

## 启动与连接

~~~bash
pnpm sam2:setup
pnpm sam2:prefetch
pnpm sam2:test
CUDA_VISIBLE_DEVICES=<已分配编号> pnpm sam2:start
~~~

上面的 GPU 占位符需替换成实际编号，不能原样执行。也可设置 SAM2_DEVICE=cpu。默认地址 127.0.0.1:7103，SAM2_PORT 可覆盖；Demo 和产品 API 使用 SAM2_ENDPOINT。

先 pnpm build，再运行 pnpm demo:net，可按需联合启动 Demo 和主体服务。/health/grounded 检查联合模型状态。

## 缓存与验证

setup／prefetch 提前取得固定权重；推理默认读取已有缓存。SAM2_ALLOW_RUNTIME_DOWNLOAD=1 才允许缺失权重在请求期间下载。普通缓存位于 .tools/huggingface/pinned。

pnpm sam2:smoke 和 pnpm sam2:grounded-smoke 会运行真实模型，需先分配设备。一次样例通过仅证明运行链路，不表示全部人像、动物或卡通图的分割质量合格。
