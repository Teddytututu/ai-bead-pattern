# Image Pindou · 图像转拼豆图纸

项目将图像转换为使用实体珠色的网格图纸，提供网页工作台、HTTP API 和微信小程序示例。

当前主生成器是 TypeScript 确定性算法：主体分析、网格采样、材料配色、轮廓与细节保护、精修、质量检查及导出。五官规则模板已删除，不提供模板补画或模板回退。

## 当前能力

| 部分 | 状态 |
| --- | --- |
| 网页生成 | 浏览器执行 Pattern Core，支持主体蒙版修正与候选比较 |
| 材料色卡 | MARD 291、Perler 123（118 色自动匹配）、通用 24 |
| 手机接入 | 微信 SDK、异步任务 API、小程序示例已有；真实域名、微信登录和真机验收需部署配置 |
| 主体与部件分析 | 可接 GroundingDINO Tiny + SAM 2.1 Small |
| 高清图 → 256×256 卡通图 | 独立 SDXL 教师审核与训练工具；尚未接入产品生成链路 |
| 256×256 卡通图 → 32／64 格 | 当前可用确定性基线；配对监督的网格网络尚未实现 |
| 局部生成 | SDXL 区域修复实验，独立于主生成器 |

## 运行

Windows 配置了 SSH 入口时，先运行：

~~~powershell
pwsh -NoProfile -File scripts/dev/remote.ps1 -Action status
pwsh -NoProfile -File scripts/dev/remote.ps1 -Command 'pnpm build'
~~~

以下命令在远端仓库根目录执行：

~~~bash
source scripts/dev/remote-env.sh
pnpm install --frozen-lockfile
pnpm build
PORT=4177 pnpm demo:quick
~~~

通过 SSH 转发访问 /apps/demo/。无模型服务时使用确定性路线；主体模型启动方式见 [SAM2](services/sam2-sidecar/README.md)。首次安装和端口配置见 [远程开发](docs/remote-development.md)。

## 验证

~~~bash
pnpm typecheck
pnpm test
pnpm test:e2e
~~~

按修改范围选择检查。Python 服务使用各自锁定环境；模型烟测与正式训练单独执行。自动化通过不表示真实图质量已经达标。

## 文档入口

- [文档目录](docs/README.md)：运行、接口、标注、数据与评测。
- [架构](docs/architecture.md)：实际执行链路和模块边界。
- [训练路线](docs/training.md)：两阶段任务、当前缺口与验收。
- [教师审核](apps/teacher-review/README.md)和[独立眼睛标注](docs/region-annotation-guide.md)：两套不同的数据流程。
- [产品 API](services/pattern-api/README.md)和[小程序](apps/wechat-miniapp/README.md)：手机客户端接入。
- [数据处理](docs/privacy.md)：上传、保存、模型调用和删除边界。

原图、标注、权重和实验结果不随 Git 分发。历史方案可从 Git 历史查阅，当前文档不保留旧实施日志。
