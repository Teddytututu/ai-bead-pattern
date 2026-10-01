# 实体材料色卡

此目录保存冻结的材料数据，由 [material-palettes](../../packages/material-palettes/)注册并提供内容版本。

| 文件 | 登记数量 | 自动匹配 |
| --- | ---: | --- |
| generic-24.json | 24 | 演示和测试色板 |
| mard-291.json | 291 | 应用 MARD 专属填色与描边策略 |
| perler-123.json | 123 | 118 个普通色，5 个特殊材质仅登记 |

id／code 表示材料身份，RGB／HEX 是屏幕参考，不是实物色差校准。透明材料与空板不同：图纸中只有空板索引表示不放珠子。

MARD 来源及 revision 保存在 JSON 元数据；Perler 的商品、参考色、图片哈希和排除项见 [来源记录](sources/perler-123-provenance.json)及[重建说明](../../docs/perler-123.md)。第三方许可文本保留在 sources，不属于过期日志。

修改数据需同时验证注册表、版本哈希、自动匹配限制、导出色号与材料统计，不能仅替换显示名称。
