# Qwen 卡通教师图：1,162 张下载与使用说明

本项目采用 2026-10-13 冻结的 **1,162 张合格 Qwen 卡通教师图**。下载方式为 **1,154 张基础包＋8 张补充包**，合并后得到完整数据集。

## 下载

| 文件 | 图片数 | 文件大小（字节） | 下载 |
| --- | ---: | ---: | --- |
| `Qwen-Chen-qualified-teachers-1154-20261013.zip` | 1,154 | 757,907,689 | [基础包](https://github.com/Teddytututu/Perler_Generator/releases/download/qwen-teachers-1154-20261013/Qwen-Chen-qualified-teachers-1154-20261013.zip) |
| `Qwen-Chen-qualified-additional-8-20261013.zip` | 8 | 7,799,342 | [补充包](https://github.com/Teddytututu/Perler_Generator/releases/download/qwen-teachers-1162-20261013/Qwen-Chen-qualified-additional-8-20261013.zip) |

[最终发布说明](https://github.com/Teddytututu/Perler_Generator/releases/tag/qwen-teachers-1162-20261013)提供完整下载入口。[完整清单](https://github.com/Teddytututu/Perler_Generator/blob/f909fcf7811af3456611066305da5eedb9b20352/data/qwen-teachers/qualified-1162-20261013/manifest.json)可单独查阅。

## 解压

1. 下载两个 ZIP，并按下方 SHA-256 校验文件。
2. 解压基础包，得到 `Qwen-Chen-qualified-teachers-1154-20261013/` 文件夹。
3. 将补充包直接解压到上述文件夹内，接受清单、CSV 和分组文件的更新。补充包中的 `images/` 与基础包中的 `images/` 合并。
4. 检查该文件夹下 `images/` 共 **1,162 个 PNG**。文件夹名称保留基础包的 `1154`，图片总数以补充后的清单为准。

合并后的关键文件：

- `images/`：1,162 张原生生成 PNG，保留像素和尺寸。
- `manifest.json`：完整的 1,162 条记录，包含来源 UID、来源编号、原图 ZIP 成员路径、原图与结果 SHA-256、分组、许可、署名、生成版本、参数配置哈希和种子。
- `teachers.csv`：完整教师图索引。
- `splits/train.json`、`validation.json`、`test.json`：固定分组 ID。
- `generation-configs/`：对应生成参数。
- `provenance/`、`inventory.json`、`package-integrity.json`：审核、来源与文件完整性证据。

## 校验值

基础包 SHA-256：

```text
158aee2229ad3e6640d1ae6c21b0a0188869eae7ea3d94aaa9d0794eb161df8b
```

补充包 SHA-256：

```text
64728f7bf3ae8e6809ab87d2f85cd19e2e37fc3099f6b92bf3ce240ffede1c8e
```

在两个 ZIP 所在目录执行 PowerShell 文件校验：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'Qwen-Chen-qualified-teachers-1154-20261013.zip'
Get-FileHash -Algorithm SHA256 -LiteralPath 'Qwen-Chen-qualified-additional-8-20261013.zip'
```

发布时已完成原生结果哈希、图片解码、源图／结果／生成记录／参数绑定检查，以及 ZIP CRC 和文件清单哈希检查。GitHub 两个下载资产的文件大小及 SHA-256 与本地核验结果一致；补充包已完整下载回验。

## 来源、审核与分组

原始来源为 CHEN Jing 提供的 `dataset.zip`，包含历史 `round_1` 的 500 张及新增 `round_2`、`round_3`、`round_4` 各 250 张，共 1,250 张。最终逐图审核接受 1,162 张，其余 88 张保留重做标签并归档。生成与迭代已按用户决定结束。

| 分组 | 合格图片数 |
| --- | ---: |
| train | 1,066 |
| validation | 48 |
| test | 48 |
| 合计 | **1,162** |

配对原图从原始 `dataset.zip` 按每条记录的 `source_archive_member` 读取，并核对 `source_sha256`。原图字节、EXIF、来源许可及署名沿用来源记录；展示或解码时按 EXIF 方向处理。原始 ZIP 的 SHA-256：

```text
48aea188795570eb498d96a2bfc4ac47ba348872b24d59f2e530cb596643ec52
```

教师图来自 Qwen 原图编辑流程，保留逐图提示词、种子和参数记录；固定设置为 BF16、768 分辨率参数、40 步、CPU offload、KVcache，后续迭代采用分块编码和整帧 BF16 VAE 解码。人工历史选择与严格视觉审核标准均保留。

这批原生图可用于后续配对数据准备。产品的 256×256 输入需按 [训练路线](training.md)另行建立固定预处理，并保留当前 train／validation／test 分组。训练启动、模型效果和产品接入分别按相应阶段验收。
