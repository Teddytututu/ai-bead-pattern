# Perler 色卡快照

perler-123 表示仓库冻结的一份 1,000 颗普通尺寸袋装目录，不表示品牌永远只有 123 色。数据见 [perler-123.json](../assets/palettes/perler-123.json)，逐项来源见 [provenance](../assets/palettes/sources/perler-123-provenance.json)。

## 数据口径

该快照从保存的商品目录筛选单色袋装，排除混色包，保留 123 个唯一 SKU。id 和 code 使用商品 SKU，不伪造短色号。

| 材质 | 数量 | 自动配色 |
| --- | ---: | --- |
| 普通颜色 | 118 | 允许 |
| Clear／Clear Blue | 2 | 禁用 |
| Glow in the Dark Green | 1 | 禁用 |
| Gold Metallic | 1 | 禁用 |
| Pearl Silver | 1 | 禁用 |

特殊材质仍可出现在完整材料目录中；其透光、夜光和反射效果不能由一个 RGB 表达。透明珠也计入材料，不能当空板。

95 项 RGB 来自冻结的 BeadColors CSV，28 项来自保存的商品色样图。来源文件哈希、提取方式及 [第三方许可](../assets/palettes/sources/beadcolors-LICENSE.txt)随仓库保留，全部 RGB 仅为 screen-reference。

## 重建

~~~bash
node scripts/maintenance/import-perler-palette.mjs output/perler-sources
~~~

脚本只读本地已下载的 perler-products.json、beadcolors-perler.csv、beadcolors-LICENSE 和 swatches 目录，校验来源哈希后重建色卡与 provenance。常规构建直接使用冻结 JSON，无需联网或重新采集。

## 运行约束

主生成器只使用可自动匹配材料，显式指定不合规轮廓色时拒绝请求。Perler 黑色正常参与匹配；MARD 的 H7 排除规则不应用于它。

API、小程序和网页共享色卡目录。图纸用色预算与完整材料库大小分开，PNG／CSV／JSON 保留 SKU、品牌、色卡版本和实际数量。色卡内容变化会改变版本，旧版本请求不会静默改用新数据。

相关验证位于 material-palettes、pattern-core、pattern-api 及 palette.e2e.mjs。实物校色和真实制作效果需另行测量。
