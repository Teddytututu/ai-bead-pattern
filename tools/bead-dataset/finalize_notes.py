"""Write a report from actual indexed counts, never from requested download totals."""
import collections
import json
from paths import ROOT

root = ROOT
rows = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['samples']
summary = json.loads((root / 'summary.json').read_text(encoding='utf-8'))
report = json.loads((root / 'expansion-report.json').read_text(encoding='utf-8'))
focus = collections.Counter(r['focus'] for r in rows)
verified_faces = focus['face'] + focus['eyes']
face_candidates = focus['face-candidate'] + focus['eyes-candidate']
total_size = sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
notes = f'''# 拼豆图纸参考数据集（2026-09-29，扩充版）

从首批 92 张扩充为 **{len(rows):,} 张有效 PNG 图纸**，约为原来的 {len(rows) / 92:.1f} 倍。原始有效图片合计 {summary['originalBytes']:,} 字节（约 {summary['originalBytes'] / 1024**2:.1f} MiB）。包括清单、网页快照、数据库和预览的整个目录约 {total_size / 1024**2:.1f} MiB。

## 数量与分类

| 项目 | 数量 |
| --- | ---: |
| 动漫类图案（含动漫风游戏角色） | {summary['categories'].get('anime', 0):,} |
| 动物类图案 | {summary['categories'].get('animal', 0):,} |
| 动漫脸部／眼部，已目视确认 | {verified_faces:,} |
| 动漫脸部／眼部，标签筛选候选 | {face_candidates:,} |
| 已完成目视分类的有效图纸 | {summary['reviewed']:,} |
| 待目视审核 | {summary['pendingVisualReview']:,} |

脸部优先是上述分类的子集，不能把表中各行相加。标签筛选与助手的目视确认分开记录，未将全部动漫图案标成脸部。`classificationMethod` 记录初筛方式，后续核对结果以 `visualReview` 和 `focus` 为准。文件数以原始图纸为单位，一张多角色或多部件图纸只计一次。

来源覆盖初音／Vocaloid、咒术回战、鬼灭之刃、火影忍者、海贼王、美少女战士、吉卜力、宝可梦等，以及猫、狗、兔、虎、熊、鸟等动物。部分是头像，部分是全身、场景或多部件拼装图；颜色品牌保留原样，未强制转为 Perler 123。

## 本地入口

- `index.html`：离线浏览页；支持标题、角色、作者和标签搜索，以及大类、题材、审核状态筛选；每页 36／72／144 张。
- `originals/`：未修改的来源 PNG，保留原有署名与配色信息。目录同时保留被去重或排除的下载文件；**有效数据以 manifest 为准**，不要直接遍历整个 originals 目录作为训练样本。
- `manifest.json` / `manifest.jsonl`：{len(rows):,} 条有效样本及其来源、作者、原图 URL、校验值和审核状态。
- `anime-face-manifest.json`：{verified_faces:,} 张已确认的动漫脸部与眼部参考。
- `anime-face-candidates.json`：{verified_faces + face_candidates:,} 张脸部优先样本，包含确认项和待确认候选。
- `dataset.sqlite3`：SQLite 数据库，表名 `patterns`，有效数据与主清单一致。
- `evaluation-manifest.json`：按项目评估清单字段组织的候选参考，`localPath` 相对于项目根目录；这不表示已接入评估或训练。
- `sources/`：来源网页快照。首批是详情页，扩充批次使用压缩的公开目录页 `*.html.gz`；每条样本都保留原详情页 URL。
- `previews/contact-*.jpg`：完整图纸的缩略预览。`face-review-*.jpg` 是用于题材检查的主体局部预览，原图没有裁剪或改动。
- `visual-review.json`：目视检查结果。`exclusions.json`、`excluded-manifest.json`：已排除样本及原因。
- `expansion-seeds.json`、`expansion-report.json`：新增候选清单与采集报告。
- `summary.json`、`gallery-validation.json`：最终计数、文件与页面校验结果。

查询脸部优先参考：

```sql
SELECT title, author, focus, original_path, source_url
FROM patterns
WHERE focus IN ('face', 'eyes', 'face-candidate', 'eyes-candidate')
ORDER BY priority, title;
```

## 下载与质量检查

本轮检查了 {report['catalogPages']} 个公开目录页，筛选出 {report['candidates']:,} 个新候选条目。扩充下载中发现 {len(report['duplicates'])} 个 SHA-256 完全重复文件，未重复入库；之后排除了 {summary['excludedAfterQualityReview']} 个空白、未完成或与人物／动物主体不符的样本。失败详情见 `expansion-report.json`。

所有有效文件均通过 PNG 解码和 SHA-256 校验，SQLite 通过完整性检查。完全相同文件已去重；不同署名、换色、镜像或近似构图仍可能表达同一角色设计。已识别的近似版本标有 `relatedVariantGroup`，后续建立训练／验证集时仍需继续按角色与相似构图分组。

扩充样本从公开目录页获取作者、题名与标签，下载完整的 1124 × 720 原图；未读取到的格数和豆数保留为 `null`，**图片像素尺寸不是拼豆格数**。原图内可读的格数、配色等信息仍完整保留。部分图使用六角底板或多部件布局，不能默认全部属于同一种方格矩阵。

## 授权与标注状态

这是本地参考候选集。训练和公开再分发许可尚未确认，所有样本仍为 `authorizationStatus: pending`、`trainingEligible: false`、`publicRedistribution: false`；未附加脸框、关键点或逐格色号真值，也未形成成对输入／输出训练数据。

来源为 [Kandi Pad](https://kandipad.com/)，每张图的具体来源见清单。站点条款快照见 `sources/terms-of-use.html`，原链接为 <https://kandipad.com/terms-of-use>。

本目录位于 Git 已忽略的 `output/` 下，原图未提交或推送。应用代码、已有评估和训练流程未因本次下载而改变。

## 重建本地索引

在项目根目录运行以下命令，不访问网络：

```powershell
py tools/bead-dataset/index_dataset.py
py tools/bead-dataset/finalize_notes.py
```

Python 依赖 Pillow。下载与整理脚本在 `tools/bead-dataset/`，版本化来源目录和审核记录在其 `snapshot/` 中。
'''
(root / 'README.md').write_text(notes, encoding='utf-8')
print(json.dumps({'total': len(rows), 'confirmedFaceAndEyes': verified_faces, 'candidateFaceAndEyes': face_candidates, 'reviewed': summary['reviewed'], 'originalMiB': round(summary['originalBytes'] / 1024**2, 1)}, ensure_ascii=True))
