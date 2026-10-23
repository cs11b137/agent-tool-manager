# atm UI 重构调研（2026-10）

> 结论先行：**推荐「shadcn/ui New York 架构（OKLCH token + copy-in 组件）× Linear 视觉语言（中性、高密度、1px hairline）」，玻璃材质按 Apple HIG 原则只保留在浮层（可开关）。**
> 依据见下文对比与引用。原型：`prototype/prototype.html`。

## 1. 现状问题（对照证据）

当前 v0.2 的 Liquid Glass 实现与三条一手指南相悖：

1. **玻璃用在内容层**。Apple WWDC25 明确："best reserved for the navigation layer that floats above the content… making [a table] Liquid Glass would make it compete with other elements and muddy the hierarchy. So keep it in the content layer instead"。atm 恰恰把 `.glass` 用在统计卡、项目卡、图例、表格上，且 "avoid glass on glass"（atm 有玻璃卡叠 mesh 背景叠玻璃弹窗三层）。
2. **颜色当装饰**。HIG："Avoid tinting all your elements… when every element is tinted, nothing stands out"。atm 的 skill/mcp/plugin 三色 chip + iris 渐变 + blob 背景让所有元素同权重。
3. **密度与可读性**。2026 SaaS 仪表盘趋势：卡片厚边框、大圆角、大 padding 正被 "minimal chrome, maximum data"（1px 边框、2–4px 圆角、行高 36–44px、mono 表格数字）取代。atm 的 20–24px 圆角玻璃卡 + 22px padding 属于上一代范式。

## 2. 候选方案对比

| | A. 收敛版 Liquid Glass | B. shadcn/ui New York | C. Linear 式自建 token | D. Base UI 重写 |
|---|---|---|---|---|
| 做法 | 保留玻璃，只用于侧栏/浮层，内容层改实色 | 采用 shadcn CLI 生成组件 + 其 token 体系 | 只换 token 与样式，组件结构保留 | 换 headless 底层 |
| 视觉 | 延续品牌，但内容层仍是重装饰 | 中性、业界默认审美 | 同 B，且可精调 | 无视觉主张（headless） |
| 工程成本 | 低（改 CSS） | 中（引入 Radix/Base UI + 重排组件） | **低（token 直接映射现有 `--glass/--ink` 变量名，组件不动）** | 高 |
| 依赖 | 无新增 | +radix-ui / +@base-ui/react | 无新增 | +@base-ui/react |
| 生态/维护 | 自维护 | shadcn 官方维护，2025 起完整支持 Tailwind v4 + React 19 + OKLCH | 自维护（量小：≈12 个组件） | Base UI v1.0（2025-12 稳定，Radix 原班人马 + MUI 团队全职维护） |
| 风险 | 密集数据下对比度/可读性问题仍在 | 观感趋同、与现有自研组件重叠 | 需要自己保证 a11y | Base UI 生态尚小；Radix 自身更新放缓（WorkOS 收购后） |

**推荐：C 为骨架，B 为规则来源**——即「shadcn 式 token 架构（OKLCH、`@theme inline`、语义槽位）+ Linear 视觉语言（中性灰阶四档、单强调色、tabular-nums、tight tracking）+ 玻璃降级为可选浮层材质」。理由：

1. 现有代码已经是「CSS 变量 + `@theme inline` + 自研小组件」，与 shadcn 架构同构，无需引依赖即可获得 B 的 90% 收益（这正是 shadcn 作者强调的 "the code you end up with is exactly what you'd write yourself"）。
2. 组件仅 ≈12 个（btn/chip/switch/dialog/select/table/diff…），copy-in 一个 headless 库收益有限；等做 Combobox/复杂下拉时再引入 `@base-ui/react`（React 19 + v1.0 稳定）或 shadcn 的 Base UI registry。
3. 视觉上向 Linear/2026 仪表盘共识收敛：内容优先、密度、克制的色彩（status 才用色）。

## 3. 视觉语言基线（细节依据）

- **色彩**：Linear 用 LCH 生成主题、中性四档文字层级（#f7f8f8 / #d0d6e0 / #8a8f98 / #62666d）、"limiting how much chrome was used… return to a more neutral and timeless appearance"。shadcn v4 全面 OKLCH。→ 本系统照搬「四档灰阶 + 单蓝强调 + 语义色仅用于状态」。
- **排版**：数字 tabular-nums + mono；标题 tight tracking（-1%～-2%）；正文 13–15px。Linear 与 2026 dashboard 共识。
- **形状**：圆角 4/8/12（cell/card/dialog），1px hairline 边框替代阴影堆叠；行高 36–44px。
- **玻璃**：仅浮层（dialog/command）保留 `backdrop-blur` 可选项，默认实色 surface——对应 HIG 的分层原则，并天然满足 Reduce Transparency / Increase Contrast。
- **信息架构**：列表页用「表行」而非卡片堆（drawer/详情页保留点击下钻）；矩阵保持 grid；KPI 顶部一排 ≤5 张、其余进表格——对应三层渐进披露（KPI → 诊断 → 明细）。

## 4. 引用

- shadcn/ui Tailwind v4/React 19/OKLCH/@theme inline：https://ui.shadcn.com/docs/tailwind-v4 · changelog https://ui.shadcn.com/docs/changelog/2025-02-tailwind-v4 · v4 里程碑 https://github.com/shadcn-ui/ui/milestone/2
- shadcn 支持 Base UI + 主题编辑器（2025-12）：https://marsbased.com/blog/2025/12/17/updates-to-shadcn-ui-base-ui-support-and-new-theme-editor
- Base UI v1.0（2025-12-11，35 组件，Radix 原班 + MUI，MIT）：https://base-ui.com/ · releases https://base-ui.com/react/overview/releases
- Radix vs Base UI 迁移差异：https://www.basecn.dev/docs/get-started/migrating-from-radix-ui
- Apple HIG Liquid Glass（玻璃仅浮层/勿全着色/可访问性修饰）：https://developer.apple.com/design/human-interface-guidelines/materials · WWDC25 219 https://developer.apple.com/videos/play/wwdc2025/219/ · WWDC25 356 https://developer.apple.com/videos/play/wwdc2025/356/
- Linear 重设计（LCH 主题、中性 timeless、对比度、Inter tight tracking）：https://linear.app/now/how-we-redesigned-the-linear-ui · 系统拆解 https://www.designmd.co/blog/linear-design-system-breakdown
- 2026 仪表盘趋势（minimal chrome/密度/1px 边框/小圆角/mono 数字/dark-first/状态才用色）：https://thekitbase.app/blog/saas-dashboard-design-trends-2026 · 三层渐进披露 https://idealogic.io/blog/dashboard-design · 密度纪律 https://www.pixel-show.com/blog/designing-data-dense-dashboards · 数字排版 https://designsignal.ai/articles/data-visualization-dashboard
