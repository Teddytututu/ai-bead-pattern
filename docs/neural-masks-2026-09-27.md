# 自动蒙版：复用现成模型

本次承接用户新增要求：所有自动蒙版由神经网络分图、定位和选取；优先网上现成模型和官方推理流程；两眼不强制等高、等大或对称。历史验收结论保持。

## 采用的现成实现

| 用途 | 来源 | 状态 |
|---|---|---|
| 主体与部件蒙版 | [Grounded-SAM-2 官方示例](https://github.com/IDEA-Research/Grounded-SAM-2/blob/dd4c5141b75e4838dd486c64f773c43b4db3a07b/grounded_sam2_hf_model_demo.py)，使用 GroundingDINO 检测框和 [Transformers SAM2](https://huggingface.co/docs/transformers/model_doc/sam2) | 已接入、真实猫图验证 |
| 重复候选去重 | [Torchvision batched_nms](https://docs.pytorch.org/vision/stable/generated/torchvision.ops.batched_nms.html)，按主体及部件类别分组 | 已接入 |
| 眼睛连通域、位置及尺寸 | [OpenCV connectedComponents、moments、minAreaRect](https://docs.opencv.org/4.x/d3/dc0/group__imgproc__shape.html) | 已接入，只处理模型已有像素 |
| 既有主体抠图 | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)，现有 rembg Provider | 保留，移除其后附加的宠物几何蒙版 |
| 人物专用五官细分类 | [BiSeNet Face Parsing](https://github.com/yakhyo/face-parsing) / [UniFace](https://github.com/yakhyo/uniface) | 已调研，尚未接入；不能代替宠物模型 |
| 文本直接分割对照 | [SAM 3](https://github.com/facebookresearch/sam3) | 官方权重需申请访问，未接入 |

没有自研分割网络、训练新分割权重或重新实现 NMS/连通域/矩计算。项目代码负责接口、坐标转换和现有模板系统对接。置信度保留模型检测分，不人为提高到 1；它不是经过业务数据集校准的正确率。

## 行为

GroundingDINO 检测主体、SAM2 分割；然后在检出的主体裁剪内再次调用官方模型获取部件蒙版。提示覆盖眼、鼻、嘴、头、耳、躯干、腿、尾、头发、皮肤、衣服、手臂和手；类别是请求范围，不承诺每张图均能检出。最多分析 8 个主体的部件，超出有警告。

双眼合并预测由 OpenCV 连通域拆分，再由 Torchvision 去重。不镜像补眼，不硬编码必须两只眼。位置、尺寸和局部方向使用 OpenCV 测量，写入 `landmarks / featureShape / featureRegionId`，接入已有 35 个模板的选择、落格。局部方向不是完整 3D 头姿，近圆蒙版方向仍可能不稳定。已修复重叠头部/眼睛语义区域错误覆盖主体承载范围、导致模板无法放置的问题。

Gateway 不再自动调用宠物几何补全；Demo 不再对不透明图片做边缘泛洪，也不再给示例猫添加椭圆脸。原图 Alpha 和已有预计算 BiRefNet 蒙版保留为来源证据。自动圈选失败时保留当前蒙版，不回退到几何分割。圈线只作为网络提示；网络结果成为编辑基底，手工补画/擦除仍支持撤销重做。

## 本地运行

本机已安装依赖、下载固定 revision 权重，已有最新构建时：

```powershell
pnpm demo:net
```

该命令启动或复用本机 `127.0.0.1:7103` 模型服务，再启动 Demo。默认页面端口被占用时递增，以终端地址为准。“分析图层”可查看眼、鼻、嘴、身体部件；“五官定位与模板”可查看并校正自动部件。

另一台电脑首次使用需先安装 uv，再执行 `pnpm sam2:setup`、`pnpm build`。后续 `pnpm demo:net` 跳过构建；改核心代码后先 `pnpm build`。`pnpm demo:quick` 只启动网页/Gateway。模型缓存在 `.tools/huggingface`，Windows 下载使用官方 `local_dir` 保存普通文件，不要求符号链接特权。`sam2:*` 指令优先使用服务虚拟环境。

Demo 沿用 `/api/ai/analyze`，自动请求主体分割、部件语义及关键点，保留蒙版、模型来源和缺失警告。显式 `providerIds` 保持调用方选择。

微信产品 API 沿用 `route: "neural-analysis"`。启动模型服务后，在 API 终端设置 `$env:SAM2_ENDPOINT='http://127.0.0.1:7103'` 再执行 `pnpm api:dev`。Worker 调用同一模型，候选继续返回 `featurePlacements`；仅配置 REMBG 时提供主体蒙版并提示未启用部件识别。

## 验证与边界

- Python 35 项、Gateway 81 项、Demo/API 82 项通过；核心/蒙版编辑定向 34 项通过，含重叠区域和倾斜/单眼回归。
- 本机 `test.jfif` 仅作本地验证，未上传远程。CUDA 实测检出 1 个主体、头、鼻、嘴、尾和 2 只眼睛；单次脚本约 7.6 秒，非性能基准。两眼原图 Y 约 91.7 和 89.1，分别保留。
- 真实浏览器完成上传、神经蒙版、自动模板和眼睛图层检查，无页面异常。记录在 `output/neural-masks-browser.json`、`neural-masks-demo.png`，模型诊断为 `neural-masks-real.json`。
- 9 项相关浏览器用例分批通过：模型路线、图层、独立眼睛模板、移动端、圈选确认/撤销/重做及网络失败后蒙版逐像素不变。编辑测试固定后续画布大小，避免重复完整候选搜索；不完整的模拟部件仍触发图纸质量门禁。轮廓元数据另由 API 集成测试验证，未放宽产品质量门槛。

尚未完成所有题材的分割质量验收。遮挡、人像、插画、多主体、细纹理仍需样本门禁；缺失类别不补画。图纸仍可能提示关键特征表达不足，模型运行成功不会绕过图纸质量门禁。模板排序沿用已有实现，本次没有宣称完成模板偏好训练。
