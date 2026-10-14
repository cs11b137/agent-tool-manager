<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/atm-logo-dark.svg">
    <img src="assets/logo/atm-logo.svg" alt="atm" height="72">
  </picture>
</p>

# atm · Agent Tool Manager

每个项目用一份清单（`.agents/tools.json`）声明所需的 Skill / MCP / 插件，`atm` 把它们落地到各 Agent（Claude Code、Cursor、Codex）的原生位置。Skill 原件统一克隆到 `~/GitHub`，项目内只放软链；MCP 只定义一次，渲染成各家格式；插件按项目启用。附带本地 GUI。

- 技术方案：[docs/tech-design.md](docs/tech-design.md)
- 包间契约：[docs/implementation-contract.md](docs/implementation-contract.md)
- 设计稿：[design/](design/)

## 安装与使用

```bash
pnpm install
pnpm -r build
node packages/cli/dist/bin.js --help      # 或 pnpm link --global 后直接用 atm
```

```bash
cd <project>
atm init                                  # 建 .agents/、清单、.claude/skills 软链、.gitignore
atm add skill jimliu/baoyu-skills baoyu-comic
atm add mcp figma --agents claude-code,cursor
atm add plugin security-guidance@claude-plugins-official
atm list
atm doctor [--measure]
atm install                               # 别人拉代码后一条命令还原
atm sync                                  # 更新共享仓库，刷新 lock
atm ui                                    # 本地 GUI
```

所有命令支持 `--json`、`--dry-run`。退出码：0 成功 / 1 有 error / 2 参数错误。

Agent 入口 Skill 在 [skill/agent-tools/SKILL.md](skill/agent-tools/SKILL.md)，软链到 `~/.claude/skills/agent-tools` 后，对 Claude Code 说「把 baoyu-skills 里的 baoyu-comic 链接到当前项目」即可。

## 仓库结构

| 包 | 内容 |
|---|---|
| `packages/core` | `@atm/core`：Manifest、Resolver、Adapters、doctor、所有写操作（先 plan 出 diff，再原子落盘） |
| `packages/cli` | `atm` 命令行，core 的薄壳 |
| `packages/server` | `@atm/server`：Hono HTTP API + SSE + token 鉴权，托管 UI 构建产物 |
| `packages/ui` | React + Vite + Tailwind 的 GUI（Liquid Glass 设计系统） |
| `skill/agent-tools` | 唯一需要全局安装的 Skill |

## 开发

```bash
pnpm -r build
pnpm -r test                               # core / cli / server / ui 的 Vitest
pnpm --filter @atm/ui dev                  # mock 数据下开发 GUI
pnpm --filter @atm/ui e2e                  # Playwright，mock 模式截图
pnpm --filter @atm/ui e2e:real             # Playwright，真实 server + 临时 HOME
```

测试从不碰真实的 `~`：core 接受 `home` / `env` 覆盖，所有 fixture 在临时目录中。

## 安全

- server 只监听 `127.0.0.1`、随机端口、随机 token，校验 `Host` / `Origin`
- 配置文件只写 `${VAR}` 变量引用；任何接口都不返回密钥值；`doctor` 扫描明文密钥
- 合并写入只改动 lock `managed` 中列出的条目，手写配置不受影响
