---
name: agent-tools
description: 管理当前项目的 Skill、MCP 和插件。用户说「把 X 链接到项目」「给项目加上 X 的 MCP」「启用 X 插件」「检查项目工具」「项目用了哪些工具」时使用。
---

# agent-tools

用 `atm` CLI 维护当前项目的 `.agents/tools.json` 清单。所有命令都支持 `--json`，优先用 `--json` 读结果。

## 流程

1. 项目还没有 `.agents/tools.json` 时先执行 `atm init`
2. 不确定工具类型或名字时：先 `atm list --json` 看当前清单，再 `atm search <name> --json` 在工具库里找
3. 按类型添加：
   - Skill：`atm add skill <owner/repo> <name>`（name 是 SKILL.md frontmatter 里的 name，不是路径）
   - MCP：`atm add mcp <name> [--agents claude-code,cursor]`；registry 里没有时，先在 `.agents/mcp/<name>.json` 写好定义（`env` / `headers` 的值只能写 `${VAR}` 引用，不能写明文密钥），再执行 add
   - 插件：`atm add plugin <plugin@marketplace>`；提示未安装时，告诉用户先在 Claude Code 里执行 `/plugin install <plugin@marketplace>`，atm 不代为安装
4. 移除：`atm remove <name>`（自动判断类型；同名歧义时加 `--kind skill|mcp|plugin`）
5. 做完执行 `atm doctor --json`，把 `error` 和 `warn` 级别的问题告诉用户，并附上每条的 `nextCommand`
6. 新增或移除的 MCP、插件需要重启 Agent 会话才会生效，要提醒用户；Skill 软链立即生效

## 注意

- 写操作前可以加 `--dry-run` 预览将要改动的文件
- 遇到 `CONFLICT`（手写条目同名）时，向用户说明后再加 `--adopt` 重试
- 不要手改 `tools.lock.json` 和各 Agent 的生成配置，统一走 `atm`
- 别人拉代码后执行 `atm install` 即可还原全部工具
