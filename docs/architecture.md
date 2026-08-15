# Architecture

## 模块关系

```text
WeChat Mini App
      |
      v
Pattern Core <---- Material Palettes
      |
      v
AI Gateway
```

`pattern-core` 保持平台无关，微信小程序负责界面和平台适配，AI Gateway 负责外部视觉能力接入。
