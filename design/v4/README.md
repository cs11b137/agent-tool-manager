# atm UI 重构 v4「Workbench」（2026-02）

> **结论：推荐「Workbench」方案 = Linear 式骨架（中性、1px hairline、高密度表行）× Geist 式表面语义（六档明度阶梯 + 交互态槽位）× Supabase 式控件规约（可编辑凹陷 / 只读 mono）× Raycast 式 accent 稀有度纪律。全部 OKLCH token，与现有变量名兼容，组件零改动可换肤。**
> 原型：`prototype/prototype.html`（6 屏 × 暗/亮 × 两档密度，截图在 `prototype/shots/`）。调研过程见下文。
>
> **状态：已确认并落地到 `packages/ui`**（tokens + index.css 换肤、Shell topbar、全部页面表行化；见 §5 已执行）。现行组件红线以 `.pi/skills/ui-design/SKILL.md` 为准。

## 1. 候选方案对比

| | A. 收敛 Liquid Glass | B. v3 Console（未确认） | **C. v4 Workbench（推荐）** | D. Terminal/IDE 风 | E. shadcn 换底座 |
|---|---|---|---|---|---|
| 做法 | 玻璃只留浮层，内容层实色 | 中性 console，两档表面 | 六档表面语义 + 更严色彩纪律 + operator 组件 | 全 mono、面板化、block 风 | 引 Radix/Base UI 重写组件 |
| 视觉上限 | 中（重装饰残留） | 中高（执行有偏差） | **高** | 个性强但亲和度差 | 中（观感趋同） |
| 工程成本 | 低 | 低 | 低（token 同构 + 组件精修） | 中（排版体系全换） | 高 |
| 新依赖 | 无 | 无 | **无** | 字体可能新增 | +radix/base-ui |
| 依据强度 | 违背 HIG 分层原则 | 方向对、细节糙 | 四方实证交叉验证 | 适合编辑器不适合管理台 | 12 个自研组件不值换底座 |

**为什么不是 B（v3）直接确认**：v3 方向正确，但对照片级执行有四个偏差——① 状态徽章用了大面积实色 pill，违反自己「色彩只表达状态且克制」的红线；② KPI 是 tint 色块卡，层级与主表抢注意力；③ 行内动作常显，扫描时噪声大；④ 表面只有两档，active/凹陷等交互态无槽位。v4 全部修正，并吸收 2026 年 dev-tool 控制台的四条新实证（见 §2）。

**为什么 C 最优**：
1. **六档表面语义**（bg / field凹陷 / surface / surface-2 hover / surface-3 active / overlay）直接照搬 Geist「Background 1/2 + Color 1–10」的 default/hover/active 心智模型，层级靠明度阶梯而非阴影——Raycast 暗色验证有效。
2. **控件规约来自 Supabase 控制台**：可编辑字段「凹陷」（field 比 bg 更深）+ ≥3:1 描边；只读值（路径/token/命令）= 填充 + mono + 浅描边，读作「可复制」；主按钮一屏一个。
3. **accent 稀有度纪律**（Raycast：accent ≤ 视野 10%）：蓝只出现在主按钮、选中左条、focus 环、矩阵 on 格；类型三色只剩 6px 圆点。
4. **状态两级强调**（trading-journal 实证）：汇总/首级数字用彩色 glyph，表内重复单元格低透明度柔化——「所有东西都强调 = 没有东西被强调」。

## 2. 关键设计决策与依据

| 决策 | 取值 | 依据 |
|---|---|---|
| 表面架构 | 六档 OKLCH 明度阶梯，dark `bg oklch(.17)` → `overlay oklch(.218)` | Geist Colors 1–10 default/hover/active 三态模型；Raycast 4 档阶梯无阴影 |
| 输入槽 | `--field` 比 bg 更深（凹陷），focus = accent border + 2px soft 环 | Supabase：「editable fields are sunk, stroke ≥3:1」 |
| 文字 | 四档 `--ink/.78/.62/.50`；正文 13px、辅助 12px、cap 11px mono 大写 | Linear caption 层级；2026 dashboard 密度共识 |
| 数字 | 全部 mono + tabular-nums + 右对齐；大数值 500 字重 22px | Geist「Label 13 Tabular」一等变体；金融终端惯例 |
| KPI | stat bar：一个 surface 容器分段竖线，无 tint 无阴影 | Vercel「克制首屏指标」；修正 v3 色块卡 |
| 行内动作 | 默认隐藏，hover/focus-within 显现 | BuiltUX：contextual hover reveal 保持扫描安静 |
| 导航选中 | surface-2 底 + 2px accent inset 左条（非整片 accent 底） | Linear 侧栏；accent 稀有度 |
| 状态 | glyph ●◆○ + 文字；表内 warn/ok 用柔和级，err 才实色 | 两级强调系统；a11y 不只靠颜色 |
| 顶栏 | 46px：mono 面包屑 + ⌘K 搜索（keycap）+ 同步状态点 | Vercel command bar；Geist Keyboard Input 组件 |
| 圆角/动效 | 6/8/10/12px；120–180ms ease-out，无延迟级联 | Railway 实测 6px/150ms；Linear ~100ms |
| 玻璃 | 仅浮层可选，默认实色 overlay | Apple HIG：玻璃属于导航浮层不进内容层 |

## 3. token 架构（tokens.css）

与 `packages/ui/src/styles/tokens.css` **变量名完全兼容**，`--glass*` 为实色别名；新增五个槽位：

- `--surface-3`：active/pressed 态（Geist Color 3）
- `--field`：凹陷输入槽（dark 比 bg 深 0.02 L）
- `--overlay`：浮层实色（dialog/toast/select menu）
- `--ink4`：第四档文字（路径、时间戳、占位符）
- `--shadow-1`：卡 hover 微升（其余阴影只给浮层）

旧动效变量保留但收敛到 ≤180ms；`@theme inline` 新增 `surface-3/field/overlay/ink4/shadow-1` 五个工具类出口。

## 4. 组件规约速查（原型为准）

- **btn**：h 30（sm 24）；`btn-p` accent 实底白字一屏 ≤1 个；`btn-g` surface + 1px line2；`btn-t` 文本；`btn-d` err-soft 底 err-ink 字
- **chip**：ghost——1px line2 + 6px 类型色圆点 + 11px mono；类型色不进底/字
- **st 状态徽章**：20px 高 mono；ok=ink3+绿点；warn=warn-soft 底；err=err-soft 底（唯一实色级）
- **kbd**：11px mono + surface-2 + line + 底部 inset 1px
- **表格**：行 44px（紧凑 32）；表头 11px mono 大写 ink3；数字列右对齐 tabular；行 hover surface-2；行内动作 hover 才现
- **sw 开关**：30×18，on=accent
- **矩阵**：26px 格；on=accent 实底白 ✓；add=accent 虚线+soft 底；del=err 同构；na=斜纹；行列头 sticky
- **diff**：mono 12px；行号列 36px；+/− 行 ok/err-soft 通栏底
- **dialog**：overlay 实色 + 12px 圆角 + 标题栏 52px 底 1px line；入场 180ms translateY(8px)→0
- **pend 待应用条**：sticky bottom，overlay + shadow + warn 计数徽章 + 预览/应用/丢弃
- **空态**：居中 12.5px ink3 + mono 注释行，无插画

## 5. 确认后迁移步骤

1. **换肤（1 次提交）**：`packages/ui/src/styles/tokens.css` ← `design/v4/tokens.css`；`index.css` 删 mesh/blob/iri/rise/lift/ca 玻璃系样式；`.btn/.chip/.sw/.input/.nv` 按 §4 调值。全站即刻换肤。
2. **骨架**：Shell 加 46px topbar（面包屑 + ⌘K + 同步状态）、侧栏宽 248→228、导航选中改左条式；PageHeader 缩为 15px/600 + cap。
3. **页面**：Overview 卡片堆 → 表行 + stat bar + 活动栏；Project 同上 + pend 条；Matrix 紧凑格；Doctor 级别分段 + 行内修复。
4. **测试**：`pnpm --filter @atm/ui test` 更新 parity/快照；e2e 冒烟。
5. **不做**：不引依赖、不动路由与数据层、不加插画/渐变、不做玻璃回归。将来需要 Combobox 再引 `@base-ui/react`。

## 6. 与 design/redesign（v3）的关系

v4 是 v3 的**替代项**而非迭代：方向同源（去玻璃、中性、密度），v4 修正执行偏差并补齐交互态/控件规约。确认 v4 后可归档 v3 目录。

## 7. 引用

- Geist 色彩/排版架构：https://vercel.com/geist/colors · https://vercel.com/geist/typography
- Linear 重设计（LCH、中性、密度）：https://linear.app/now/how-we-redesigned-the-linear-ui
- Linear/Geist/Raycast 深扒（accent 稀有度、表面阶梯、keycap）：https://github.com/nopperabbo/kiroxy/blob/main/docs/REFERENCE_GALLERY.md
- Supabase 控制台规约（凹陷字段/只读 mono/单主按钮/focus 环）：https://base.sbarah.com/en/docs/reference/console-design/ · https://tastekit.dev/gallery/apps/supabase
- 2026 dev dashboard 共识（hover 行内动作、mono tabular、OKLCH）：https://builtux.com/b2b-saas-developer-dashboard-ui-architecture-2026/
- 数据密度纪律（两级强调、表行 36–44px）：https://pixel-show.com/blog/designing-data-dense-dashboards
- shadcn token 槽位 / Tailwind v4 OKLCH：https://ui.shadcn.com/docs/theming · https://ui.shadcn.com/docs/tailwind-v4
- Railway 实测（单 accent、6px radius、150ms）：https://mozaika.design/website/railway
- Apple HIG 材质分层：https://developer.apple.com/design/human-interface-guidelines/materials
