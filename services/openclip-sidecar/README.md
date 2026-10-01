# OpenCLIP 图像对评分

服务使用 ViT-B-32、laion2b_s34b_b79k 的固定权重，比较原图与候选。模型 revision 及来源见 [contracts.py](src/openclip_sidecar/contracts.py)。

图片等比放入 224×224 白底画布，返回语义相似度、类别分布保留和宠物／鸟类别边际。confidence 表达原图类别证据集中程度，不能当作候选的通过概率。原始向量仅在服务内缓存。

## 使用

~~~bash
pnpm openclip:setup
pnpm openclip:test
pnpm openclip:start
~~~

默认 127.0.0.1:7102，OPENCLIP_PORT 可覆盖；Demo 配置 OPENCLIP_ENDPOINT。OPENCLIP_DEVICE 和 OPENCLIP_PRECISION 选择设备与精度；共享 GPU 另设 CUDA_VISIBLE_DEVICES。

pnpm openclip:smoke 接受 --reference、--candidate 和 --candidate-id，用于真实图像对运行检查。安装和单元测试不代替该检查，也不证明跨题材排序有效。固定比较集上的质量评测由 tools/auto-eval 管理。
