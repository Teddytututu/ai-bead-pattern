# Roadmap

## Phase 1: Baseline

状态：v0.3.3 Analysis Evidence 与 v0.3.3.1 Evidence Performance Hardening 已完成，主体形状、SDF 边界优化、CanvasPlan、FeatureBudget、多来源视觉证据合同和稳定 identity 已进入执行链路。

已交付 RGBA 输入、固定/自动画布、A0/A1/MVP 对照、Lab 配色、网格整理、多候选排序、材料统计、最终网格特征可见度、硬特征整区锁定和分项评分。

## Phase 2: Structure Planning

状态：Structure Planning 前半段完成。ShapeVariantCache 已统一规划与执行使用的目标形状；主体 mask、landmark、语义区域和裁剪置信度已经解耦，Gateway 支持模型与人工证据融合。v0.3.4 Mask Correction Core 与 Demo 编辑器已完成，包含归一化笔迹、连续软笔刷、Session 撤销重做、草稿确认分离、稳定 revision、三色覆盖层、增量显示预览和确认后单次生成。桌面与移动端浏览器 smoke 已进入 CI。

下一批内容依次为 Mask Failure Gate、人物视觉分析、FeatureConstraint、五官模板、StructurePlan 和 PIA-lite 空间映射。

## Phase 3: Value And Palette Planning

实现语义连通区域、鲁棒明暗角色、区域颜色角色、真实材料色卡联合优化和统一网格能量。

## Phase 4: Product Validation

MARD 291、带色号 PNG/CSV/JSON 导出、产品 HTTP API、微信 SDK 和原生最小页面已完成本地实现。用户选择先交付本地版本，HTTPS 环境、正式微信登录与 Android/iOS 真机验收后续接入。验收状态见[本地交付记录](local-delivery-2026-09-26.md)。完整编辑、历史作品中心与真实用户评估继续列入后续工作。
