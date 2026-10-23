# atm Console 设计系统（v3 草案）

> 原型见 `prototype/prototype.html`（暗/亮切换、6 屏 + 弹窗）。本文件是实施规格；
> 调研依据见 [RESEARCH.md](./RESEARCH.md)。确认后按「迁移策略」落地到 `packages/ui`。

## 0. 一句话

内容优先的本机控制台：中性实色表面、1px hairline、高密度表行、单一蓝强调、语义色只表达状态，玻璃材质降级为浮层可选项。

## 1. 原则

1. **数据是主角**：装饰性背景（mesh/blob/iris 渐变）全部移除；色彩只用于 状态（err/warn/ok）、类型（skill/mcp/plugin 的小面积标记）、强调（唯一 accent 蓝）。
2. **表面两层 + 浮层**：`surface`（卡/侧栏/输入）与 `surface-2`（hover/表头/嵌套），弹窗用实色 `overlay` + 投影；`backdrop-blur` 仅作为浮层可选材质开关（默认关，HIG 分层原则）。
3. **密度分级**：表行 40px（紧凑 32px）、卡 padding 16px、页面留白 24px；字号正文 13px、辅助 12px。
4. **数字即排版**：所有数值/路径/token 数用 mono + `font-variant-numeric: tabular-nums`；大数值用 500 字重而非 700。
5. **对比度**：文字 ≥ 4.5:1，glyph/边框 ≥ 3:1；`prefers-reduced-motion`、`prefers-contrast`、`prefers-reduced-transparency` 均有降级。

## 2. 令牌（tokens）

完整数值见 `tokens.css`（与现版 `packages/ui/src/styles/tokens.css` 同构：`:root` 亮色 + `[data-theme='dark']` + `@theme inline` 暴露给 Tailwind）。**保留全部现有变量名**（`--ink/--ink2/--ink3/--accent/--line/--bg/--skill/--mcp/--plugin/--err/--warn/--ok/*-soft/*-ink`…），新增表面系，旧 `--glass*` 变为实色别名——组件代码零改动即可换肤。

| 组 | 令牌（dark 值） | 用途 |
|---|---|---|
| 表面 | `--bg oklch(.17 .006 262)` `--surface oklch(.21 .006 262)` `--surface-2 oklch(.25 .007 262)` `--overlay oklch(.23 .007 262)` | 页面 / 卡·侧栏·输入 / hover·表头 / 弹窗 |
| 文字 | `--ink .96` `--ink2 .76` `--ink3 .585` | 四档层级：标题 / 正文 / 辅助（第四档用 `--ink3` 40% 透明即 caption） |
| 线 | `--line 白 9%` `--line2 白 16%` | 分隔线 / 强边框·表格头下线 |
| 强调 | `--accent #3d8bff`（亮 `#0066ff`）+ `-h/-ink/-soft` | 主按钮、选中态、链接、focus 环。全站唯一品牌色 |
| 类型 | `--skill #5fd3e2` `--mcp #3d8bff` `--plugin #b795ff` + `-ink/-soft` | Kind 标记：chip 圆点、ContextBar 分段、矩阵图例。**不再大面积使用** |
| 状态 | `--err #ff5f56` `--warn #ffb84d` `--ok #34d399` + `-ink/-soft` | Doctor 级别、校验、delta |
| 形状 | `--radius-cell 4` `--radius-card 8` `--radius-panel 10` `--radius-dialog 12` | 全站（原 8/12/16/20/24 收敛） |
| 阴影 | `--shadow`（浮层两级）`--shadow-1`（卡 hover 微升） | 边框承担大部分层级，阴影只给浮层 |
| 字体 | `--sans` 系统栈（SF Pro/PingFang）`--mono`（JetBrains Mono/SF Mono） | 无外部字体下载 |
| 动效 | `--dur-1 120ms` `--dur-2 180ms` `--ease-out cubic-bezier(.2,.8,.2,1)` | hover/按下/弹窗入场；删除 rise 延迟级联 |

玻璃兼容层：`--glass ≡ --surface`、`--glass-2 ≡ --surface-2`、`--glass-strong/--glass-dialog ≡ --overlay`（数值在 tokens.css 里是实色；浮层想开玻璃时改 overlay 一处即可加 `backdrop-filter`）。

## 3. 组件规格（对应现有组件 → 改法）

| 组件 | 现状 | v3 规格 |
|---|---|---|
| `PageHeader` | 36px 粗体大标题 + cap | 15px/600 标题 + 12px `cap`（mono 小写间距字）+ 右侧动作组；`ca` 渐变字删 |
| 统计 Stat 卡 | 玻璃 16px 圆角 | surface + 1px line、radius-card、padding 16；值 mono tabular 22px/500 + 12px 子说明；≤5 张横排 |
| `ProjectCard` | 玻璃卡 + chips 堆叠 | **表行**（见 §4 总览）：名称+mono 路径、agent 小 chip、ContextBar（高 6px）+ `≈1.9k`、计数 trio、doctor 徽章、行尾动作；hover `surface-2`；缺失项目行灰置 + `重定位/移除` |
| `KindChip` | 彩底彩字 | **ghost chip**：透明底 + 1px line + 左侧 6px 类型色圆点 + 12px 文本（类型色只出现在圆点）。选中/悬停才上 `*-soft` |
| `ContextBar` | 8px 圆角条 | 6px 高、radius 3px、分段间 2px 空隙、末尾 8% 斜纹表未测量（保留） |
| `btn`（p/g/d/t） | 胶囊玻璃 | radius-cell；`btn-p` = accent 实底白字（hover -h）；`btn-g` = surface 底 1px line2；`btn-d` = err-soft 底 err-ink 字 1px err 边；`btn-t` 文本钮；高度 28（sm）/ 32 / 36（lg） |
| `Select`/输入 | 玻璃 | surface 底、1px line2、focus 2px accent 环；内嵌 icon 16px |
| `Dialog` | 玻璃 24px 圆角 | overlay 实色 + `--shadow` + radius-dialog 12px + 标题栏 56px 底部 1px line；入场 180ms `--ease-out` translateY(8px)→0；`Esc`/scrim 关闭（现有行为保留） |
| Diff 视图 | — | mono 12px 行、行号列 40px、`+` 行 `ok-soft` 底 / `−` 行 `err-soft` 底、路径头 surface-2；`dryRun=1` 徽章 `warn-soft` |
| 矩阵 | 44px 玻璃格 | **28px 紧凑格**：on = accent 实底白 ✓；off = 透明 1px line；add = 1.5px dashed accent + accent-soft；remove 同构 err；na = 斜纹；表头/列头 sticky、mono |
| Doctor 列表 | 卡片 | 表行：级别 glyph（●◆○ 保留）+ 标题 + `fixable` 时行尾 `btn-g` 修复 + 展开明细 |
| 侧栏 Shell | 玻璃 + mesh | surface 实色 + 右侧 1px line；宽 232px；导航分组标题 11px mono；活动项 = accent-soft 底 + 2px accent 左条；底部设置区；**可选** dark 下 `backdrop-blur` |
| Toast/Toaster | — | overlay 底 + shadow + radius 8 + 左侧 3px 状态色条，280ms 入场 |
| 空态 Empty | — | 居中 12px ink3 说明 + 单个 `btn-p` 主行动，无插画 |

图标：沿用 `lucide-react`（MIT，已是依赖），尺寸 16（行内）/18（按钮），1.75px stroke，颜色跟文字层级。

## 4. 屏幕级布局（原型已实现，以原型为准）

1. **总览**：KPI 条（4：项目、库内工具、Σ上下文、健康）→ 项目表（featured 首行 = 最近活跃，`iri` 去除）→ 活动流（12px mono 时间 + 文本，右栏 320px）。
2. **项目详情**：头部（名称 + mono 路径 + agent ghost chips + 上下文摘要）→ 工具表（kind 圆点、name/repo、tokens、enabled switch、行尾移除）→ 「批量变更」PendingBar + 预览 diff。
3. **工具库**：工具栏（搜索 + 类型分段筛选 + 「搜索安装…」主钮）→ 工具表（来源 mono、tokens、被 N 项目使用）。
4. **矩阵**：紧凑格 + 底部图例 + PendingBar；点格即时改观感，攒批预览。
5. **健康检查**：级别分段头（error/warn/info 计数）→ issue 行（可修复带「修复」按钮）→ 「全部修复」在页头。
6. **添加工具弹窗**：表单（ghost chips 选 agent）→ diff 确认（§3 Diff）→ 应用。

## 5. 可访问性检查点

- 焦点环：`:focus-visible` 2px `--accent` + 2px offset（保留现状）。
- 状态不只靠颜色：err/warn/ok 均配 glyph 形状（●◆○）与文字。
- `prefers-reduced-motion: reduce` → 所有过渡归零；`prefers-contrast: more` → line2 边框加深、文字层级压缩为两档；`prefers-reduced-transparency` → 浮层 blur 关闭（实色本就是默认）。
- 表格语义：原型用 `<table>`；实施沿用现有 div 行结构时补 `role`。

## 6. 迁移策略（确认后执行，不动业务逻辑）

1. 第 1 步（1 次提交）：`tokens.css` 换成 `design/redesign/tokens.css`（变量名兼容），`index.css` 删 mesh/iri/rise/lift 玻璃样式、按 §3 调 `.btn/.chip/.sw/.glass` 等类 → 全站即刻换肤。
2. 第 2 步：`Overview/Project` 卡片改表行布局（组件级），`PageHeader` 缩小。
3. 第 3 步：矩阵紧凑格、diff 视图、侧栏实色化。
4. 全程 `pnpm --filter @atm/ui test`（现有 27 个测试文件含 parity/snapshot，token 换值后更新快照）；e2e 冒烟照跑。
5. 若后续需要 Combobox/复杂弹层：引 `@base-ui/react`（v1.0，MIT）按需 copy-in，不整包引入。

## 7. 明确不做

- 不引 Tailwind 之外的 CSS 框架/主题包；不下载外部字体（系统栈）；不做 mesh/blob/玻璃内容层回归；不加新路由或数据层改动；桌面壳（Tauri）不变。
