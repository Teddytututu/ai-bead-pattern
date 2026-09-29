# 当前计划与执行顺序

更新：2026-09-29。当前已包含 Perler 123 接入、MARD 协调性修正和 `0.10.2-perler-color-fidelity` 配色修正；新增[拼豆图纸五官提取与模板模型计划](bead-facial-template-learning-plan.md)，仅为方案评审稿，尚未实施。

本目录是计划入口。P0–P10 的阶段状态和验收清单只在[当前实施计划](contours-features-editing-perler-123-plan.md)维护；本页提供协作摘要与下一步，旧计划放在 `archive/`。架构、研究与已执行实验记录继续放在 `docs/`，不混入当前待办。

## 当前事实

- **Perler 123 已接入现有链路**：123 个 SKU 已登记，118 个普通色自动匹配，5 个特殊材质色不自动匹配；生成、现有适配、统计、导出、API/SDK 已接通。完整逐格编辑器联动仍依赖 P6/P7。参考 RGB 尚非实物测色，见[接入记录](../perler-123.md)。
- **本次反馈对应 Perler 123**：MARD 291 是此前满意的参照。Perler 保色流程的取色偏移与精修抹除细节已修复，三张固定图的颜色误差均降低；登记 RGB 未改动，黑白等参考色域差距仍存在，见[修复记录](../perler-color-fidelity-2026-09-28.md)。
- **MARD 配色碎裂已定位并修复**：用户确认此前满意的是 MARD 291。过度硬锁细微色调与逐格恢复阻止了去噪，已恢复有界色块归纳并保留语义特征；三张固定图已做视觉对照，见[修复记录](../mard-color-coherence-2026-09-28.md)。三套色卡的完整真实质量门禁仍待完成，修复前数据见[初次排查](../color-fidelity-triage-2026-09-28.md)。
- **五官模板是规则基线**：35 个模板及定位、联合落格和人工校正已有首批实现，见[实现记录](../contours-features-2026-09-27.md)。三套色卡的模板选择、参数与候选排序学习仍属于未完成的 P9。
- **图纸参考集已下载，模板真值尚未建立**：2,435 张有效图纸，已确认动漫脸部 115 张、眼部 23 张；训练资格元数据仍待确认，见[数据集说明](../../tools/bead-dataset/README.md)。新计划先验证逐格还原和现成模型预标注，再比较模板库、选择模型与受约束生成模型；不把下载量视为有效训练量。
- **其他新增功能仍按阶段推进**：结构模板/纹理保护、预览色号开关、全色库逐格编辑、矩形画布编辑和完整集成验收尚未交付。历史功能验收范围见[历史基线](../roadmap.md)。

## 下一步

1. **完成配色质量门禁（P1/P8）**。在已修正的 Perler/MARD 基线上扩展人物、多色宠物和插画样本；收集实际反馈原图与参数，分别记录颜色误差、色块协调性与重要局部特征。Perler 参考 RGB 的实物校准需求继续单独推进。
2. **准备模板样本（P0/P3/P4）**。按照[五官模板新计划](bead-facial-template-learning-plan.md)，固定用户已确认的 GroundingDINO Tiny + SAM 2.1 Small，冻结协议，再规划约 240 张图纸的小样本解码／分图试验。补齐逐格矩阵、来源、训练可用范围和人工接受／拒绝标签，可与配色门禁独立开展；本轮未启动试验。
3. **基线通过后训练（P9）**。先训练模板选择，再做参数策略和候选排序；新增的离散模板生成模型按新计划作为后续受约束试验，须证明优于检索／选择基线。按来源图片／身份分组切分数据，24/123/291 分别评估；总体门槛、产物和回退条件仍见[训练要求](contours-features-editing-perler-123-plan.md#p9模板参数与排序训练)。
4. **继续编辑与本地闭环（P5–P7/P10）**。依照当前计划完成编辑、画布修改、API/SDK 和浏览器/小程序集成；P8 完整编辑联动在这里收尾。

现有偏好采集工具、规则模板数量、已生成图纸或色卡注册，都不能单独作为“模板训练完成”的证据。

## 复查入口

```powershell
pnpm build
pnpm --filter @ai-bead-pattern/material-palettes test
node --test apps/demo/miniapp-palette.test.mjs
pnpm exec playwright test apps/demo/palette.e2e.mjs
node scripts/triage-color-fidelity.mjs
```

拉取 TypeScript 或色卡资源变更后先构建，再运行 `pnpm demo:quick`；它直接读取 `dist`，不会替新源码构建。样例诊断产物写入被 Git 忽略的 `output/`。

## 历史计划

这些文件保留原设计时点供追溯，正文中的旧排期和缺口不作为今天的待办。

- [MARD 291 与微信接口原计划](archive/mard-291-wechat-api-plan.md)
- [算法实现原规划](archive/algorithm-implementation-plan.md)
- [V2 算法升级原方案](archive/algorithm-upgrade-v2.md)

本次整理修正了 P0/P8 表格与勾选清单的矛盾，保留历史验收记录，并统一了移动文档的仓库内引用。后续完成阶段时先更新当前实施计划，再链接真实实现/验证记录。
