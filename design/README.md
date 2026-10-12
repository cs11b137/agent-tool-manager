# atm GUI 设计稿

设计稿是**参考原型**，不是生产代码：要还原的是 HTML 里内联 style 和 `<style>` 块中的颜色、字号、间距、圆角、阴影，在 `packages/ui` 中用自己的组件实现。`support.js` 和 `vendor/` 只是渲染运行时。

## 内容

| 目录 | 页面 | 对应技术方案 |
|---|---|---|
| [liquid-glass/](./liquid-glass/) | Liquid Glass 设计系统：颜色 token（亮 / 暗）、材质、动效、字体、形状、基础组件 | §9.6 |
| [prototypes/01-overview/](./prototypes/01-overview/) | 总览 | §9.2 总览 |
| [prototypes/02-project-detail/](./prototypes/02-project-detail/) | 项目详情 · web-app | §9.2 项目详情 |
| [prototypes/03-add-mcp-diff/](./prototypes/03-add-mcp-diff/) | 添加 MCP · diff 确认 | §9.3 dryRun |
| [prototypes/04-doctor/](./prototypes/04-doctor/) | 体检 | §9.2 体检 |
| [prototypes/05-matrix/](./prototypes/05-matrix/) | 矩阵 | §9.2 矩阵 |
| [prototypes/06-library/](./prototypes/06-library/) | 工具库 | §9.2 工具库 |

每个目录都有 `preview.png`（1440 宽整页截图），不打开浏览器也能直接看。

尚无原型：§9.2 的「全局 → 项目迁移」页（P5）。

## 本地查看

```bash
cd design && python3 -m http.server 8766
# 打开 http://localhost:8766/prototypes/01-overview/Overview.dc.html
```

用 `file://` 直接打开时，部分浏览器会拦截脚本。
