---
name: ui-design
description: atm UI 的 v3「Console」设计系统规约。改 packages/ui 的样式、组件外观、新增页面或弹窗前使用；含 token 对照、组件规格、密度与可访问性红线，以及「待确认状态」的边界。
---

# ui-design（atm Workbench v4）

**v4「Workbench」已确认并落地 `packages/ui`**：token 在 `packages/ui/src/styles/tokens.css`（与 `design/v4/tokens.css` 同源），组件类在 `src/styles/index.css`。新 UI 工作一律遵循下方 v4 红线。设计依据与调研：`design/v4/README.md`；原型留档：`design/v4/prototype/`。旧方案 v3 存档于 `design/redesign/`（仅参考）。

## 已落地结构速查（packages/ui）

- Shell：全高实色侧栏（228px）+ 46px topbar（mono 面包屑 + 连接状态）；导航选中 = surface-2 底 + 2px accent 左条。
- 共用类：`.tbl`（表卡）、`.tbl-head`、`.statbar`（KPI 分段）、`.st .st-err/.st-warn/.st-ok`（状态徽章）、`.kbd`、`.seg-group`（分段器）；`.glass` 保留为实色表面别名。
- Overview/Project/Library/Matrix/Doctor 均已表行化；行内动作 hover/focus-within 显现。
- 测试环境：Node ≥ 26 的实验性 localStorage 存根会遮蔽 jsdom，`src/test/setup.ts` 已有内存 Storage 兜底，不要删。

## v4 视觉红线（写组件样式时自查）

- accent 蓝 ≤ 视野 10%：主按钮（一屏 ≤1）、选中左条、focus 环、矩阵 on 格。类型三色（skill/mcp/plugin）只允许 6px 圆点与 ContextBar 分段。
- 表面只用六档阶梯 `--bg/--field(凹陷输入)/--surface/--surface-2(hover)/--surface-3(active)/--overlay`；层级靠明度不靠阴影；`backdrop-filter` 仅浮层且默认关。
- 可编辑字段凹陷（`--field` + 1px line，focus accent border + 2px soft 环）；只读值（路径/token/命令）= 填充 + mono + 浅描边，读作「可复制」。
- 状态两级强调：表内重复单元格柔和（ink3+glyph），首级/汇总才用彩色；err 是唯一实色级；状态均配 ●◆○ glyph。
- 行内动作默认隐藏，`:hover`/`:focus-within` 显现；表格数字右对齐 + tabular-nums。
- 圆角 6/8/10/12（cell/card/panel/dialog）；动效 120–180ms，无延迟级联；行高 44（紧凑 32）。
- 尊重 `prefers-reduced-motion / prefers-contrast / prefers-reduced-transparency`。

## v3 规格（备选方案，被 v4 替代前有效）

v3 设计稿在 `design/redesign/`（RESEARCH.md · design-system.md §6 有它自己的落地四步）。与 v4 差异：v3 表面只两档、无 field/overlay 槽位、状态徽章与 KPI 卡用色更重。

## 用户确认后的落地要点（design-system.md §6）

1. 第 1 步只换 `packages/ui/src/styles/tokens.css` ← `design/redesign/tokens.css`（**变量名全部同名**，`--glass*` 变实色别名），并删 `index.css` 的 `.mesh/.iri/.rise/.lift` 与玻璃样式——全站即刻换肤，组件不用动。
2. 第 2 步把 Overview/Project 的卡片改表行布局、`PageHeader` 缩小；第 3 步矩阵紧凑格、diff 视图、侧栏实色化。
3. 跑 `pnpm --filter @atm/ui test` 更新快照（parity/snapshot 会因 token 换值变化），e2e 冒烟照跑。
4. 需要复杂 Combobox/弹层时才引入 `@base-ui/react`（v1.0，MIT），不整包引入；图标继续用已有 `lucide-react`，16/18px、1.75 stroke。

## v3 视觉红线（写组件样式时自查）

- 颜色只允许：状态（err/warn/ok）、类型小面积标记（chip 6px 圆点、ContextBar 分段）、唯一强调蓝 `--accent`。禁止装饰性渐变/背景。
- 表面只用 `--surface / --surface-2 / --overlay`；`backdrop-filter` 仅浮层且默认关（HIG：玻璃属于导航浮层，不进内容层）。
- 数值、路径、token 数：`font-variant-numeric: tabular-nums` + `--mono`，表格右对齐。
- 圆角只用 `--radius-cell 4 / --radius-card 8 / --radius-dialog 12`；分隔靠 1px `--line/--line2`，阴影只给浮层。
- 行高 40px（紧凑 32）；卡 padding 16px；正文 13px、辅助 12px。
- 状态不能只靠颜色：err ● / warn ◆ / info ○ glyph + 文字；`:focus-visible` 2px accent 环。
- 尊重 `prefers-reduced-motion / prefers-contrast / prefers-reduced-transparency`（tokens.css 已带）。

## 原型工具

- 重生成截图：仓库根 `node design/redesign/prototype/shoot.mjs`（用 @atm/ui 的 Playwright，6 屏 × 暗/亮）。
- 原型是单文件无依赖 HTML（`prototype.html`），改样式直接改内联 `<style>` 里的 token 段（与 tokens.css 保持同步）。
