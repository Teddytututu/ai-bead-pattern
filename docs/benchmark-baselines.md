# 统一图纸基线

`tools/real-pet-benchmark` 提供统一输入、网格尺寸、色板、主体 trimap 与输出指标的基线注册表。

| ID | 状态 | 运行方式 | 论文复现 | 来源 |
|---|---|---|---|---|
| `mvp` | native | pattern-core MVP | 否 | 本仓库 |
| `area` | native-ablation | area coverage quantization | 否 | 本仓库 `image.ts` |
| `nearest` | native-ablation | nearest-neighbour sampling | 否 | 本仓库 `image.ts` |
| `pixeloe` | adapted-heuristic | MVP + full outline + area coverage | 否 | [PixelOE](https://github.com/KohakuBlueleaf/PixelOE) |
| `myos` | external-optional | 通过 `MYOS_COMMAND` 调用外部 wrapper | 否 | [Make Your Own Sprites](https://github.com/WuZongWei6/Pixelization) |

PixelOE 适配器用于建立轮廓感知规则代理，输出会写入 `implementationStatus=adapted-heuristic` 与 `paperReproduction=false`。其结果具备比较价值，含义属于“本仓库规则代理”与其他基线的对照。

MYOS 适配器默认生成 `skipped` 行，并写出跳过原因。运行 MYOS 前，使用者需要自行安装其源码、权重和依赖，再通过 `MYOS_COMMAND` 提供一个已约定输入输出的推理 wrapper。仓库不会把缺失的外部权重包装成论文复现。

## 用法

```bash
# 40 张图片 × 5 尺寸 × 3 个本地基线 = 600 个可运行版本
node tools/real-pet-benchmark/run.mjs --baselines mvp,area,nearest --sizes 24,32,48,64,80

# 增加 PixelOE 规则代理；它仍然带有明确的适配状态
node tools/real-pet-benchmark/run.mjs --baselines mvp,area,nearest,pixeloe

# 查看 MYOS 的可用状态（默认输出 skipped 行）
node tools/real-pet-benchmark/run.mjs --baselines myos
```

每次运行都会生成：

- `baseline-registry.json`：版本、来源、许可提示、运行状态；
- `metrics.jsonl`：每个图纸版本一行，包含 `baseline`、`implementationStatus`、`paperReproduction`；
- `metrics.csv`：便于汇总比较的扁平指标；
- `preference-export.jsonl`：后续人工 A/B 标注输入。
