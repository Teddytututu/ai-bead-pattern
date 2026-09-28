# Perler 123 色卡接入（2026-09-28）

## 数据口径

`perler-123` 是本次冻结的普通尺寸 Perler 1,000 颗袋装目录版本，不声称品牌在所有日期都只有 123 色。

以[官方颜色商品接口](https://perler.com/collections/shop-by-color/products.json?limit=250)返回的 161 项商品为来源，选择标题以 `1,000 Perler Beads - ` 开头的 129 项，排除带 `Multi-Color` 标签的 6 项（5 个混色包及 Zebra Stripe），得到 **123 个唯一 SKU**。对应[官方 1,000 颗目录](https://perler.com/collections/1-000ct-bead-bags)。不混入 Mini/Caps，不按列表位置截取。

完整数据见 [perler-123.json](../assets/palettes/perler-123.json)，逐项商品链接、RGB 来源、图片哈希及排除清单见 [provenance](../assets/palettes/sources/perler-123-provenance.json)。

| 数据 | 数量 | 处理 |
| --- | ---: | --- |
| 普通颜色 | 118 | 参与自动配色 |
| Clear / Clear Blue | 2 | 透明材质，保留登记，不自动匹配 |
| Glow in the Dark Green | 1 | 夜光材质，同上 |
| Gold Metallic | 1 | 金属材质，同上 |
| Pearl Silver | 1 | 珠光材质，同上 |

`id` 与 `code` 均使用官方商品 SKU（例如 `80-19001`、`PER17648`），作为可采购标识；不伪造短色号。特殊材质的 `finish` 与 `automaticMatch: false` 随完整目录返回。透明豆仍计为一颗材料，只有网格 `-1` 表示不放豆子。

## RGB 来源与局限

- 95 项复用 [BeadColors 固定提交](https://github.com/maxcleme/beadcolors/blob/c8e4892ac8bdd352465e9db6cdbd1e7b4cdcbd27/raw/perler.csv)的 RGB，保留其 [MIT 许可](../assets/palettes/sources/beadcolors-LICENSE.txt)。
- 28 项来自各商品的官方 SWATCH 图片：23 项新增普通色、5 项特殊材质显示参考色。算法取中央 80% 区域，缩放至 256×256 sRGB，选亮度 35–75 百分位像素，再取各通道中位数，降低孔洞阴影与高光的影响。
- 全部标记 `rgbKind: screen-reference`。这不是实物仪器测色，照片曝光、阴影和批次会影响实际匹配。特殊材质的透光、夜光、反射效果不能由单个 RGB 模拟。
- 没有把上游历史 103 项直接改名为 123。其 8 项不在本次官方目录中：Spice、Periwinkle Blue、Slime、Neon Blue、Sunflower、Lemon、Celery、Mocha。这里只报告目录差异，不推断其停产状态。

导入脚本 `node scripts/import-perler-palette.mjs [下载目录]` 从本地原始下载重建色卡和来源记录，不联网。默认输入 `output/perler-sources`，需要 `perler-products.json`、固定提交的 `beadcolors-perler.csv`、`beadcolors-LICENSE` 和 28 个 `swatches/<SKU>.jpg`。脚本核对源 JSON/CSV SHA-256，来源记录保存每张色样图片 SHA-256；图片不提交到仓库。已有构建只读取冻结的色卡 JSON，不需要下载数据或联网。

## 接入行为

- 网页色卡选择器由共享注册表生成，提供 MARD 291 / Perler 123 / 通用 24。选 Perler 后显示 123 色登记、118 色自动配色；单张最多用色仍为 48，完整库大小与单张用色预算分开。
- 小程序从 `GET /v1/palettes` 加载目录，按返回 ID 选择，消除原先的两项索引判断；加载失败可重试，并保留未改变色卡时的请求重试记录。
- API 目录增加 `automaticColorCount`；详情保留材质标记。SDK 导出相应类型。版本仍由完整色卡内容哈希确定，包括材质与匹配策略；旧版本请求会被拒绝。
- A0/A1/MVP 均只把可自动匹配颜色交给生成流程。轮廓显式指定特殊材质时拒绝，而非静默替换。局部自动适配不会把特殊材质传播给邻格；调用方显式固定的特殊材料可以保留。
- PNG/CSV/JSON 保留真实 SKU、Perler 品牌和版本及一致的材料计数。PNG 按最长代码扩大格宽，8 字符 SKU 使用 46 像素格子，避免跨格重叠。
- 默认仍是 MARD 291；其 H7 填色排除与单色描边策略继续只针对 MARD。Perler 的黑色可以正常使用。

本次贯通现有生成、适配接口、统计与导出。计划中的完整逐格编辑器、移动端全套色号预览与微信真机联调仍由各自阶段处理。

## 验证

- `pnpm test`：**749 项通过**，包括完整构建、核心算法、色卡、API/SDK、Gateway、各 gate、auto-eval 和网页/小程序逻辑测试。
- `pnpm typecheck`：通过，包含原生小程序 TypeScript。
- `pnpm exec playwright test apps/demo/palette.e2e.mjs`：1 项通过（20.4 秒），通过界面切换 MARD / Perler / 通用色卡，验证 Perler PNG/CSV/JSON 实际下载、色号、计数与特殊材质排除。
- 专项回归覆盖全部 118 个普通色的精确色号映射、5 个特殊色的三基线过滤、透明豆与空格区分、固定透明豆的适配、数据损坏和陈旧版本拒绝、小程序接口目录顺序变化与失败重试。
- PNG 人工检查：完整 Perler SKU 位于格内，品牌、版本、坐标与材料清单完整。示例为本机 `output/perler-123-pattern.png`。
- `git diff --check`：通过。

浏览器用例先等待初次生成结束，再从真实界面切到固定 32 格、Fast、还原风格、确定性路线。测试替身的神经眼睛蒙版与真实猫照片不匹配，会触发现有质量门槛，不能要求该候选可下载；没有绕过或放宽生产质量门槛。全量测试初次遇到沙箱子进程限制，获准后重跑；回归中保留了 MARD 无可用非黑色时原有错误说明。

性能入口 `scripts/benchmark-palette.mjs` 已加入 Perler 123。以下为相同 `sample-cat.png`、64×64、Fast、还原单候选、最多 20 色的各一次独立进程冒烟结果（Windows / Node 25；进程先预热一次）。这是接入后的量级检查，不是统计性能基线或真实模型质量验收。

| 色卡 | 本次生成耗时 | 进程峰值 RSS | 结果 |
| --- | ---: | ---: | --- |
| 通用 24 | 632 ms | 142 MiB | success，9 色 |
| Perler 123（自动 118） | 795 ms | 143 MiB | success，20 色 |
| MARD 291 | 831 ms | 149 MiB | success，20 色 |

复现命令：`node scripts/benchmark-palette.mjs --case perler-123 cat-photo 64 fast 1`（其他色卡替换 ID）。日志在 `output/perler-tests.log`、`output/perler-typecheck.log`、`output/perler-e2e.log` 和 `output/perler-benchmark-*.log`。未进行实物色差校准、完整多场景质量 gate 或微信真机联调。
