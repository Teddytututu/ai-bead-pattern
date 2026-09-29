# 拼豆图纸参考集与采集工具

2026-09-29 的本地采集结果包含 **2,435 张有效 PNG 图纸**，原图共 141,971,432 字节（135.4 MiB）。来源为 Kandi Pad 的公开 Fuse Bead 图纸，优先收集动漫脸部，也包含动漫人物和动物。

| 项目 | 数量 |
| --- | ---: |
| 动漫类（含动漫风游戏角色） | 1,606 |
| 动物类 | 829 |
| 已目视确认的动漫脸部／头像 | 115 |
| 已目视确认的动漫眼部 | 23 |
| 已完成目视分类的有效图纸 | 739 |
| 待目视审核 | 1,696 |

脸部和眼部是动漫类的子集；题材标签是初筛，`visualReview` 与 `focus` 记录助手后续的目视确认。一次多角色图纸只计一张。初始 92 张扩充后，20 个完全重复文件未重复入库，25 个空白、未完成或题材不符的样本被排除。所有有效原图通过 PNG 与 SHA-256 校验，SQLite 完整性检查通过。近似构图、镜像、换色版本仍可能存在。

## 版本管理与本地文件

Git 保存采集、索引、浏览和校验工具，以及 `snapshot/` 中的来源与审核元数据：

- `catalog.jsonl`：2,435 条有效图纸的来源 URL、原图 URL、作者、SHA-256、路径、分类与授权状态。它是固定批次的精简目录，不含图片，也不是采集器的工作清单。
- `seeds.json`：首批 92 条种子；`visual-review.json`、`exclusions.json`：目视审核与排除记录。
- `summary.json`、`gallery-validation.json`：本批次实际数量、完整性与离线浏览检查结果。

原图、网页快照、完整清单、预览和 SQLite 位于仓库根目录下的 `output/datasets/bead-patterns-2026-09-29/`，沿用 `output/` 的 Git 忽略规则。克隆仓库不会自动取得这些文件。

打开本地数据目录中的 `index.html` 可离线搜索、分页，并按分类、脸部优先及审核状态筛选。`manifest.json` / `manifest.jsonl` 是有效样本清单；`anime-face-manifest.json` 包含 138 张确认的脸部／眼部参考；`dataset.sqlite3` 中的 `patterns` 表与主清单一致。原图目录仍保留被去重或排除的文件，读取数据时应以主清单为准。

## 使用

需要 Python 3.10+ 和 Pillow；浏览验证使用仓库已有的 Playwright。以下命令在仓库根目录运行，输出位置固定为上述批次目录。

```powershell
py -m pip install -r tools/bead-dataset/requirements.txt
```

已有本地完整清单和原图时，以下步骤完全离线：

```powershell
py tools/bead-dataset/index_dataset.py
py tools/bead-dataset/finalize_notes.py
node tools/bead-dataset/validate_gallery.cjs
```

索引器重建 JSON、JSONL、脸部子集、评估格式清单、SQLite、联系表和浏览页。审核记录优先取本地数据目录，缺失时读取版本化的 `snapshot/`；原图缺失或哈希不符会报错。报告脚本还需要采集器生成的 `expansion-report.json`。浏览验证需要已安装 Chromium（首次可运行 `pnpm exec playwright install chromium`）。

在尚未下载该批次的机器上，可主动运行采集命令；这些步骤会访问网络：

```powershell
py tools/bead-dataset/collect.py
py tools/bead-dataset/expand.py
py tools/bead-dataset/index_dataset.py
py tools/bead-dataset/finalize_notes.py
```

首批采集详情页和 92 个种子原图；扩充脚本按动漫、脸部、眼部、角色和动物关键词访问 132 个公开目录页，目标为至少 2,400 张。为补偿重复项，下载队列额外预留 80 个候选，因此数量可能超过目标。它使用三个下载线程、全局请求间隔、16 MiB 响应上限，以及来源域名检查；遇到 401、403、429 时停止。成功文件和目录页可复用；首批脚本拒绝覆盖数量超过种子批次的扩充清单，扩充脚本达到目标后直接退出。公开内容会变化，重新采集不保证与固定快照逐条一致。

## 数据含义

完整 PNG 图纸保留作者、水印和配色信息，没有转换成 Perler 123。扩充批次未解析出的格数和豆数为 `null`；1124 × 720 是图片像素尺寸，不能当作拼豆格数。部分图是六角底板或多部件布局。

本批次是本地参考候选，尚未具备确认的训练和公开再分发许可。所有条目保留 `authorizationStatus: pending`、`trainingEligible: false`、`publicRedistribution: false`。它没有脸框、关键点、逐格色号真值或配对训练输入；`evaluation-manifest.json` 仅与项目清单格式兼容，尚未接入应用评估或训练。来源条款链接为 [Kandi Pad Terms of Use](https://kandipad.com/terms-of-use)，本地已有快照保存在数据目录的 `sources/terms-of-use.html`。

查询确认的脸部与眼部参考：

```sql
SELECT title, author, focus, original_path, source_url
FROM patterns
WHERE focus IN ('face', 'eyes')
ORDER BY priority, title;
```
