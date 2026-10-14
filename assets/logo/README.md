# atm logo

单层 `a`：蓝色圆环 + 紫色竖杆。竖杆是终端光标，圆环是被管理的"节点"。配色沿用 GUI 的 `#0066FF → #8E6CFF`。

| 文件 | 用途 |
|---|---|
| `atm-logo.svg` / `atm-logo-dark.svg` | 横向锁定（符号 + 字标 `tm`），浅色 / 深色背景。字标由几何路径构成，无字体依赖 |
| `atm-logo-black.svg` / `atm-logo-white.svg` | 单色横向锁定（打印、水印、徽章） |
| `atm-symbol.svg` | 仅符号，双色，无底 |
| `atm-symbol-black.svg` / `atm-symbol-white.svg` | 仅符号，单色 |
| `atm-icon.svg` / `atm-icon-512.png` | App 图标：渐变圆角底 + 白色符号 |
| `favicon.svg` / `favicon.ico` / `apple-touch-icon.png` | 网页图标（已复制到 `packages/ui/public/`） |
| `atm-logo.png` / `atm-symbol-512.png` | 位图预览 |

## 规则

- 色值：蓝 `#0066FF`、紫 `#8E6CFF`、墨 `#0B1220`。底为渐变时符号一律用白色。
- 最小尺寸：符号 16 px（用 `favicon.svg`）；横向锁定高度 ≥ 24 px。
- 留白：四周至少一个竖杆宽度（符号高度的 22%）。
- 不要：拉伸、旋转、给符号加阴影或描边、把圆环与竖杆改成同色（双色版）、在 `atm` 后面追加文字。

## 几何（256 网格）

圆环：圆心 (111,128)，外径 76，笔画 34。竖杆：34×152，圆角 10，与圆环右侧齐平。
`tm` 沿用同样的 34 笔画；x 高 152，字间距 30。

## 来源

用 [kaankiziltug/logo-design-skill](https://github.com/kaankiziltug/logo-design-skill) 的流程设计（概念 → 测试 → 套件），
通过 `atm add skill` 安装在本项目 `.agents/skills/`。未做商标检索，对外商用前请自行核查。
