# Test Fixtures

算法评估样例目录，覆盖人像、宠物、插画、风景与特殊光照图片。

- `images/frog.jpg`、`images/kitten.jfif`：从仓库根目录迁入的现有对照图片，仅移动位置，不新增训练或分发资格。
- `benchmarks/`：已有 24／291 色性能 JSON，保留原测量时间与版本，供回归参考。
- `dataset-manifest.*.json`：评测数据清单示例与格式。

Demo 测试位于 `apps/demo/tests/unit` 和 `apps/demo/tests/e2e`，核心／服务测试留在各自包内；生成的报告与截图不放入本目录。

核心包当前包含三组可复现 Golden：降采样差异、结构整理差异、硬特征保护差异。真实图片评估集进入仓库前需确认授权和再分发许可。

`dataset-manifest.schema.json` 用于登记私有或公开评估样本。清单记录授权状态、内容指纹、标注位置、再分发状态和评估维度，受限图片继续保存在私有存储中。
