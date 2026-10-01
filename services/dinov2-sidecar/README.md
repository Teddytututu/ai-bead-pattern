# DINOv2 图像对评分

服务使用固定 facebook/dinov2-small，比较原图与候选的全图、主体、头部和关键局部视图，返回 CLS 相似度和 patch 对应指标。原始嵌入不作为 HTTP 结果输出。

模型 revision、输入合同及来源记录见 [contracts.py](src/dinov2_sidecar/contracts.py)。视图等比放入 224×224 白底画布；相似度用于辅助排序，不直接判断图纸是否可制作。

## 启动

~~~bash
pnpm dinov2:setup
uv run --project services/dinov2-sidecar --python 3.11 python -m dinov2_sidecar.prefetch
pnpm dinov2:test
DINOV2_PORT=7106 pnpm dinov2:start
~~~

代码默认端口为 7105，与 Pattern API 冲突，因此以上示例使用 7106。Demo 同时设置 DINOV2_ENDPOINT=http://127.0.0.1:7106。DINOV2_DEVICE=cpu 可选 CPU；使用 CUDA 时明确选择 GPU。

/health 区分缺少权重、已缓存但未加载、已加载。默认提前 prefetch，DINOV2_ALLOW_DOWNLOAD=1 才允许请求时下载缺失权重。固定环境与权重不代表已经完成真实质量评测。
