# v4 Workbench 落地 Brief（subagent 执行用）

> 你是实施工蜂。仓库根 = `/Users/wuwenjun/personal/projects/agent-tool-manager`。
> 设计原型：`design/v4/prototype/prototype.html`（可打开参考视觉）；token：`design/v4/tokens.css`（已复制到 `packages/ui/src/styles/tokens.css`）；组件 CSS 已重写在 `packages/ui/src/styles/index.css`。**这两个 CSS 文件已完成，禁止再改。**

## 总原则

1. **只改视觉与布局结构，零逻辑改动**：不增删 import 之外的功能代码；不改 i18n 文案与 `msg()` 调用结构；不改事件处理、hooks、查询、条件渲染；不改 `aria-*`、`role`、按钮文字（测试依赖这些选择器）。
2. **不引新依赖**；不新增 CSS 文件；Tailwind 类直接用（v4 主题已暴露 `bg-surface/surface-2/surface-3/field/overlay`、`text-ink2/ink3/ink4`、`border-line/line2`、`bg-err-soft`、`text-warn-ink` 等，见 tokens.css 底部 `@theme inline`）。
3. 完成后自检：`cd packages/ui && npx tsc --noEmit` 必须零报错。**不要跑 vitest**（由编排方统一跑）。

## 已完成的基建（可直接用的类）

| 类 | 语义 |
|---|---|
| `.glass` | **已变为实色表面**（surface + 1px line，无模糊）。新代码优先用语义类/工具类替代它 |
| `.tbl` | 表格容器：surface + line + radius 8 + overflow hidden |
| `.tbl-head` | 表头单元：11px mono 大写 ink3 |
| `.statbar` | KPI 单容器分段：grid + 子项 padding 12/16 + 左 1px line（首个无） |
| `.st .st-err/.st-warn/.st-ok` | 状态徽章：20px mono；err 实色 soft、warn 柔和、ok 中性 ink3 |
| `.kbd` | 快捷键 keycap |
| `.btn/.btn-p/.btn-g/.btn-d/.btn-t/.btn-sm/.btn-lg` | 已 v4 化（32px/radius 6） |
| `.chip .c-skill/.c-mcp/.c-plugin/.c-agent/.c-muted` | 已 ghost 化（类型色只剩 6px 圆点，CSS 自动渲染） |
| `.input/.label/.agt/.seg/.tab/.cell/.sw` | 已 v4 化（input 凹陷 field、cell 26px、sw 30×18） |
| `.sidebar-*` `.topbar` `.topbar-crumb` `.topbar-status` | Shell 已落地 |

## 已删除的 CSS 类（JSX 里必须清掉引用）

`mesh` `blob` `iri` `ca`（渐变文字）`lift`（hover 放大）`rise` `d1`–`d5`（延迟级联）。JSX 里出现一律删除；玻璃相关的 inline style（`background: var(--glass-strong)` 等）按下方映射改。

## 视觉映射规则（旧 → 新）

| 旧 | 新 |
|---|---|
| `glass ... rounded-[20px]` 卡 | `rounded-[8px] border border-line bg-surface`（或保留 `glass` 类+改圆角） |
| inline `background: var(--glass-strong)` | 删除或改 `var(--overlay)`（浮层）/ `var(--surface)`（卡） |
| inline `background: var(--glass-2)` / `bg-glass-2` | `bg-surface-2` / `var(--surface-2)` |
| 大标题 `text-[36px] font-bold` / `ca` | `text-[15px] font-semibold`（PageHeader 已内置，页面自定义头部照此） |
| 大数字 `text-[32px]/[34px] font-semibold` | `text-[22px] font-medium mono`（tabular-nums 已在 .mono） |
| 卡片 padding `p-[22px]` / `px-[18px] py-4` | `p-4` / `px-3.5 py-3` |
| 圆角 `rounded-[16px]/[20px]/[24px]` | `rounded-[8px]`（浮层 `rounded-[12px]`） |
| 行高 `min-h-[60px]` 表行 | `min-h-[44px]` |
| 表行内边距 `px-[18px]` | `px-[14px]` |
| 选中行 `background: var(--accent-soft)` | `var(--surface-2)` + `boxShadow: inset 2px 0 0 var(--accent)` |
| 彩色 chip 状态（err/warn/ok 的 `chip` + soft 背景 inline） | `.st .st-err/.st-warn/.st-ok` 类 |
| `LevelGlyph` 用法 | 不变 |

## 红线

- accent 蓝只出现在：主按钮、选中态左条、focus 环、矩阵 on 格、链接。禁止大面积 `--accent-soft` 铺底。
- 禁止装饰性渐变、网格背景、`backdrop-filter`（浮层默认实色 overlay + `var(--shadow)`）。
- 数字一律 `mono` + 右对齐（表格数字列）。
- 状态色（err/warn/ok）之外无彩色；类型三色只剩 `.chip` 圆点与 ContextBar 分段。
- 保持暗/亮双主题只靠 token，禁止写死颜色值。
