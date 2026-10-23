# atm Console v3 — UI 重构设计稿（待确认）

> 调研：[RESEARCH.md](../RESEARCH.md) · 设计系统规格：[design-system.md](../design-system.md) · 令牌：[tokens.css](../tokens.css)
> **本目录是「待确认的设计原型」，未动 `packages/ui` 任何代码。** 确认后按 design-system.md §6 三步迁移。

## 怎么看

```bash
# 方式一：直接开（无外部脚本，file:// 可用）
open design/redesign/prototype/prototype.html
# 方式二：
cd design/redesign/prototype && python3 -m http.server 8766
```

交互：左栏切换 6 屏（总览/项目详情/工具库/工具关联/健康检查/本机工具）；工具库点「搜索安装…」或项目页「添加工具」打开**添加工具 → diff 确认**弹窗（Esc 关闭）；左下角按钮切换**暗/亮**与**紧凑密度**（40px↔32px 行高）；矩阵单元格点击演示 on/add/remove 状态机；健康检查行内「修复断链」演示 toast。

`shots/` 内 12 张 1440×900 截图（6 屏 × 暗/亮），`shoot.mjs` 用仓库自带 Playwright 重新生成：

```bash
node design/redesign/prototype/shoot.mjs   # 在仓库根执行
```

## 审阅清单（确认时逐项过）

1. **总览**：KPI 一排 4 张 + 项目从「玻璃卡」改为**表行**（密度 ↑，信息不丢：上下文条、计数、状态徽章都在）——接受表行形态？
2. **色彩**：mesh/blob/iris 渐变全部移除；类型色只出现在 chip 圆点与上下文分段；全站唯一强调蓝——接受「颜色只表达状态」？
3. **形状**：圆角 8/12（原 16–24）、1px 边框、行高 40/紧凑 32——密度是否合适？
4. **弹窗**：实色 + 投影（玻璃按 HIG 降为可选浮层材质，默认关）——OK？
5. **diff 视图**（弹窗第二步）：mono + 行内红绿 + `dryRun=1` 徽章——沿用？
6. **矩阵**：28px 紧凑格 + 斜纹缺失列——比 44px 玻璃格信息密度高一倍，OK？

## 与现状的差异摘要

| 维度 | v0.2 Liquid Glass | v3 Console |
|---|---|---|
| 表面 | 全站玻璃 + mesh blob 背景 | 实色 `surface/surface-2`，玻璃仅浮层可选 |
| 项目列表 | 大卡片（≈150px 高） | 表行（40px）+ 活动右栏 |
| 类型色 | 彩底彩字 chip | ghost chip + 6px 色点 |
| 圆角 | 8–24px | 4–12px |
| 数字 | mono 28px 粗体 | mono tabular 22px/500（表格右对齐） |
| 动效 | rise 级联 480ms | 120–180ms hover/入场 |
| 兼容 | — | 变量名与现版全部同名，tokens.css 可直接替换换肤 |
