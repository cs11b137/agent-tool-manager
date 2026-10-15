# atm（Agent Tool Manager）技术方案

> 版本：v0.1 草案 · 日期：2026-10-12 · 前置文档：[feasibility.md](./feasibility.md)

## 1. 目标与非目标

**目标**
1. 每个项目用一份清单声明所需的 Skill / MCP / 插件，按需装载，不再全局常驻
2. Skill 原件统一克隆到 `~/.agent-tools`，项目内只放软链；`git pull` 一次即可让所有项目同步，修改原件可直接给上游提 PR
3. MCP 只定义一次，自动渲染成各 Agent 的原生配置
4. 团队可复现：别人拉代码后执行 `atm install` 即可还原
5. 能估算每个项目的工具上下文占用
6. 提供本地 GUI：跨项目查看「哪个项目用了哪些工具」，点选即可增删，直观看到上下文占用

**非目标（v1 不做）**
- 不做在线市场，也不做云端同步
- 不托管密钥，只做变量引用和扫描
- 不支持 Windows 软链（首版仅 macOS / Linux）
- 不替代 Claude Code `/plugin` 的安装流程，只管理启用范围

---

## 2. 核心概念

大模型（大脑） + Agent 运行时（手脚） + 工具。工具分三类：

| kind | 对应物 | 落地方式 | 常驻上下文 |
|---|---|---|---|
| `skill` | Skill（`SKILL.md` 目录） | 软链 | name + description |
| `capability` | MCP server | 渲染配置文件 | 全部工具 schema |
| `bundle` | Claude Code 插件 | 写 `enabledPlugins` | 取决于内含的 skill / MCP |

---

## 3. 总体架构

```
   用户 / Agent（自然语言）          用户（浏览器）
            │                             │
  agent-tools/SKILL.md               atm ui（本地 Web）
            │                             │ HTTP + SSE
         atm CLI                     atm server
            └──────────────┬──────────────┘
                     @atm/core（共享核心）
   ┌───────────────┼────────────────┐
   │               │                │
Manifest       Resolver          Adapters
tools.json     ├ SkillResolver   ├ claude-code
tools.lock     ├ McpRegistry     ├ cursor
               └ PluginIndex     └ codex
   │               │                │
项目目录        ~/.agent-tools/*        各 Agent 原生配置
```

- **Manifest**：读写 `tools.json` 和 `tools.lock.json`
- **Resolver**：把清单里的名字解析为实体（目录、MCP 定义、插件内容）
- **Adapter**：每个 Agent 一个，负责落地到该 Agent 的原生位置，彼此互不依赖

技术选型：Node ≥ 20 + TypeScript，依赖尽量少（`smol-toml` 处理 Codex TOML，其余用标准库）。以 `npx atm` 或全局安装 `atm` 分发。

**CLI 和 GUI 共用同一个核心**：所有逻辑放在 `@atm/core`，CLI 和 GUI 都只是薄壳，两边的行为不会出现分叉。仓库结构（pnpm monorepo）：

```
packages/
  core/     # Manifest、Resolver、Adapter、doctor，纯函数 + 文件 IO
  cli/      # 参数解析 → 调用 core → 输出文本或 JSON
  server/   # 本地 HTTP API → 调用 core
  ui/       # 前端（React + Vite），构建产物打包进 cli，由 server 托管
```

---

## 4. 文件与目录布局

### 4.1 全局

```
~/.agent-tools/                         # 统一仓库根目录，可配置
  baoyu-skills/                   # Skill 仓库（git clone）
  mcp-registry/                   # MCP 定义仓库（可以是私有仓库）
    figma.json
    playwright.json
~/.config/atm/config.json         # 全局配置
```

`config.json`：

```json
{
  "root": "~/.agent-tools",
  "mcpRegistry": "~/.agent-tools/mcp-registry",
  "defaultAgents": ["claude-code"],
  "projects": [
    "~/personal/workspace/agent-tool-manager",
    "~/work/web-app"
  ]
}
```

GUI 的「工具库」与「设置」提供「初始化共享目录…」：创建共享根目录和 MCP registry 后保存配置，已有内容不覆盖，失败只回滚本次新建且仍为空的目录。更换路径不迁移已有仓库或项目软链。显式保存的旧路径继续生效。

`projects` 是项目注册表，供 GUI 做跨项目视图：执行 `atm init` 或在项目中执行任意写操作时自动登记；目录不存在时 GUI 将其标灰，由用户决定是否移除。

### 4.2 项目内

```
<project>/
  .agents/
    tools.json                    # 清单，提交
    tools.lock.json               # 锁文件，提交
    skills/                       # 软链，gitignore
      baoyu-comic -> ~/.agent-tools/baoyu-skills/skills/baoyu-comic
  .claude/
    skills -> ../.agents/skills   # 软链，gitignore
    settings.json                 # enabledPlugins 由 atm 合并写入，提交
  .mcp.json                       # Claude Code MCP，由 atm 生成，提交
  .cursor/mcp.json                # Cursor MCP，由 atm 生成，提交
  .codex/config.toml              # Codex MCP，由 atm 生成，提交
```

**提交策略**：软链一律 gitignore（换台机器就是断链）；生成的配置文件只含变量引用、不含密钥，**允许提交**。这样没装 atm 的队友也能直接用 MCP 和插件，只有 Skill 需要 `atm install`。

`atm init` 会自动往 `.gitignore` 追加：

```
.agents/skills/
.claude/skills
```

> `.claude/skills` 已经是实体目录时，`init` 先把里面的内容迁移到 `.agents/skills/`，再改成软链；遇到冲突则报错退出，不覆盖。

---

## 5. 数据模型

### 5.1 `tools.json`（人写，或由 atm 维护）

```json
{
  "$schema": "https://atm.dev/schema/tools.v1.json",
  "agents": ["claude-code", "cursor"],
  "skills": [
    { "repo": "jimliu/baoyu-skills", "name": "baoyu-comic" },
    { "repo": "jimliu/baoyu-skills", "name": "baoyu-cover", "rev": "v1.2.0" }
  ],
  "mcp": [
    "figma",
    { "name": "playwright", "agents": ["claude-code"] }
  ],
  "plugins": [
    "security-guidance@claude-plugins-official"
  ]
}
```

字段规则：
- `skills[].repo`：`owner/repo` 或完整 git URL；对应克隆到 `<root>/<repo>`
- `skills[].name`：Skill 名称，按 `SKILL.md` frontmatter 的 `name` 匹配，不写路径；仓库结构变了也不受影响
- `skills[].rev`：可选。分支、tag 或 sha，缺省跟随默认分支
- `mcp[]`：字符串表示引用 registry 中的同名定义；对象形式可以覆盖 `agents`
- `plugins[]`：`plugin@marketplace`，只对 `claude-code` 生效

### 5.2 `tools.lock.json`（atm 生成，不手改）

```json
{
  "version": 1,
  "skills": {
    "baoyu-comic": {
      "repo": "jimliu/baoyu-skills",
      "path": "skills/baoyu-comic",
      "commit": "a1b2c3d",
      "contextTokens": 96
    }
  },
  "mcp": {
    "figma": { "hash": "sha256:…", "contextTokens": 4200 }
  },
  "managed": {
    "claude-code": { "mcp": ["figma", "playwright"], "plugins": ["security-guidance@claude-plugins-official"] },
    "cursor":      { "mcp": ["figma"] }
  }
}
```

- `commit`：`install` 时如果仓库 HEAD 与之不一致，只**警告**，不自动 checkout（共享克隆被多个项目共用，切换会影响别的项目）；用 `--strict` 时才报错
- `managed`：记录 atm 写进各 Agent 配置的条目。**合并写入只会改动这里列出的条目**，用户手写的部分不受影响

### 5.3 MCP 定义（registry 中的 `<name>.json`）

```json
{
  "name": "figma",
  "description": "Figma 设计文件读取",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "figma-developer-mcp", "--stdio"],
  "env": { "FIGMA_API_KEY": "${FIGMA_API_KEY}" }
}
```

HTTP 类型：

```json
{
  "name": "linear",
  "transport": "http",
  "url": "https://mcp.linear.app/mcp",
  "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" }
}
```

约束：`env` 和 `headers` 的值必须是 `${VAR}` 形式，否则 registry 校验直接失败。

---

## 6. 模块设计

### 6.1 SkillResolver

```
resolve(repo, name, rev?):
  dir = <root>/<repoName>
  if !exists(dir): git clone <url> dir
  elif remote(dir) != url: 报错「目录已被其他仓库占用」，提示改用 <owner>-<repo>
  candidates = glob(dir, "**/SKILL.md")，跳过 node_modules / .git
  match = 读 frontmatter.name == name 的那一个
  兜底：目录名 == name
  0 个 → 报错并列出可用名字；多个 → 报错并列出路径
  return { path: relative(dir, match.dir), commit: git rev-parse HEAD }
```

- `rev` 不为空且与 HEAD 不同时：警告「共享仓库在 <HEAD>，清单要求 <rev>」，不自动切换。确实需要隔离时，可用 `atm pin <skill>` 为它建一个 `git worktree`（`<root>/.worktrees/<repo>@<rev>`），软链改为指向 worktree
- 发现结果缓存在 `~/.config/atm/cache/<repo>.json`，以仓库 HEAD 作为缓存键

### 6.2 McpRegistry

- 从 `config.mcpRegistry` 目录读取 `*.json`，用 JSON Schema 校验
- 项目内可以放 `.agents/mcp/<name>.json` 覆盖或新增定义（优先级高于全局 registry），方便项目私有的 MCP 随仓库一起提交

### 6.3 PluginIndex

- 读取 `~/.claude/plugins/installed_plugins.json` 和对应的插件目录
- 展开插件内容：`skills/**/SKILL.md`、`.mcp.json`、`commands/`、`agents/`、`hooks/`
- 用途：`doctor` 用它检测重复（插件自带的 MCP 与清单里的 MCP 同名），以及估算上下文占用
- 插件未安装时：提示用户先执行 `/plugin install <name>`；atm 不代为安装

### 6.4 Adapters

统一接口：

```ts
interface Adapter {
  id: "claude-code" | "cursor" | "codex"
  linkSkills(projectDir: string, names: string[]): Promise<void>
  writeMcp(projectDir: string, servers: McpDef[], managed: string[]): Promise<string[]>  // 返回新的 managed 列表
  writePlugins?(projectDir: string, plugins: string[], managed: string[]): Promise<string[]>
  detect(projectDir: string): Promise<boolean>
}
```

| Adapter | Skill 入口 | MCP 文件与格式 | 变量引用写法 | 插件 |
|---|---|---|---|---|
| claude-code | `.claude/skills → .agents/skills` | `.mcp.json`，`{ mcpServers: { name: { command, args, env } \| { type: "http", url, headers } } }` | `${VAR}` 原样保留 | `.claude/settings.json` 中的 `enabledPlugins` |
| cursor | `.cursor/skills → .agents/skills`（待验证） | `.cursor/mcp.json`，同样是 `mcpServers` 结构 | `${env:VAR}`（待验证） | 无 |
| codex | `.agents/skills`（待验证是否原生读取） | `.codex/config.toml`，`[mcp_servers.<name>]`（仅受信任项目生效） | 待验证 | 无 |

**合并写入算法**（每个 Adapter 都一样）：

```
current = 读已有配置（不存在则为空）
for name in managed_old - desired: 删除 current[name]
for s in desired:
  if current 已有 s.name 且 s.name ∉ managed_old:
    报错「<file> 中已有手写的 <name>」，加 --adopt 时转为由 atm 管理
  current[s.name] = render(s)
原子写入（先写临时文件再 rename），保留原有缩进风格
return desired 的名字列表 → 写回 lock.managed
```

### 6.5 上下文占用估算

| 对象 | 估算方法 | 精度 |
|---|---|---|
| Skill | frontmatter 中 `name + description` 的字符数 ÷ 4（中文按 ÷ 1.5） | 粗略，够用 |
| MCP | `doctor --measure`：启动 server，调用 `tools/list`，对返回的 schema JSON 计数 | 准确，但需要可用的密钥 |
| 插件 | 内含 skill 与 MCP 之和 | 同上 |

未测量过的 MCP 显示为 `?`，测量结果写回 lock，避免重复启动 server。

---

## 7. 命令规范

| 命令 | 作用 | 主要步骤 |
|---|---|---|
| `atm init` | 初始化项目 | 建 `.agents/`、空清单；迁移已有的 `.claude/skills`；更新 `.gitignore` |
| `atm add skill <repo> <name>` | 加 Skill | 解析 → 写清单 → 建软链 → 更新 lock |
| `atm add mcp <name> [--agents a,b]` | 加 MCP | 校验定义 → 写清单 → 各 Adapter 合并写入 |
| `atm add plugin <id>` | 启用插件 | 检查是否已安装 → 写清单 → 写 `enabledPlugins` |
| `atm remove <name>` | 移除 | 自动判断类型；删软链 / 删受管条目；更新清单和 lock |
| `atm install` | 按清单还原 | 克隆缺失仓库 → 建全部软链 → 全量渲染 MCP 与插件 → 比对 lock |
| `atm sync [repo]` | 更新上游 | 对涉及的仓库执行 `git pull --ff-only`；有本地改动则跳过并提示 → 更新 lock |
| `atm list` | 查看 | 列出本项目的工具：类型、来源、commit、估算 token |
| `atm doctor [--measure]` | 体检 | 见下表 |
| `atm pin <skill> <rev>` | 隔离版本 | 建 worktree，软链改为指向它 |

`doctor` 检查项：

| 检查 | 级别 |
|---|---|
| 断链（软链目标不存在） | error |
| 配置中出现明文密钥（值不是 `${…}`，且 key 名包含 KEY / TOKEN / SECRET） | error |
| 项目 Skill 与 `~/.claude/skills` 中的全局 Skill 同名 | warn |
| 清单中的 MCP 与已启用插件自带的 MCP 同名 | warn |
| 共享仓库有未提交改动或未推送的提交 | info（提示可以提 PR） |
| 全局启用、但只有本项目在用的插件 | info（建议改为项目级） |
| 本项目工具总上下文占用 | info |

所有命令都支持 `--json` 输出，供 Agent 解析；退出码：0 成功，1 有 error，2 参数错误。

---

## 8. Agent 入口 Skill

`agent-tools/SKILL.md` 放在 `~/.agent-tools/atm/skill/`，这是**唯一需要全局安装的 Skill**。

```markdown
---
name: agent-tools
description: 管理当前项目的 Skill、MCP 和插件。用户说「把 X 链接到项目」「给项目加上 X 的 MCP」「启用 X 插件」「检查项目工具」时使用。
---

1. 不确定类型时先执行 `atm list --json`，再执行 `atm search <name> --json`
2. Skill：`atm add skill <owner/repo> <name>`
3. MCP：`atm add mcp <name>`；registry 里没有时，先在 `.agents/mcp/<name>.json` 写好定义
4. 插件：`atm add plugin <plugin@marketplace>`；提示未安装时，告诉用户执行 `/plugin install`
5. 做完执行 `atm doctor --json`，把 error 和 warn 告诉用户
6. 新增的 MCP 或插件需要重启会话才会生效，要提醒用户
```

---

## 9. GUI

### 9.1 形态选择

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **本地 Web（`atm ui`）** | 复用 Node 核心，零额外安装，跨平台 | 需要开浏览器，没有托盘图标 | **v1 采用** |
| 桌面应用（Tauri） | 原生体验、托盘、开机启动 | 要打包签名；Rust 壳与 Node 核心之间需要通信 | P6 已加入实现，复用 v1 前端；平台验收见 desktop.md |
| VS Code 扩展 | 贴近编辑器 | 只覆盖 VS Code 系用户，跨项目视图别扭 | 不做 |

启动：`atm ui` 启动本地 server，自动打开浏览器；在项目目录中执行时，默认打开该项目的页面。

### 9.2 页面

> 视觉设计与原型见 [design/README.md](../design/README.md)（Liquid Glass 设计系统 + 6 个页面原型）。

| 页面 | 内容 | 主要操作 |
|---|---|---|
| **总览** | 已注册项目的列表；每个项目显示 Skill / MCP / 插件数量、上下文占用条、doctor 状态灯 | 打开项目、批量执行 `install`、`sync` |
| **项目详情** | 三栏：Skill、MCP、插件，每项显示来源、commit、token 占用、生效的 Agent | 开关启用、移除、按 Agent 勾选、查看生成的配置 diff |
| **工具库** | `~/.agent-tools` 下所有可发现的 Skill、registry 中的 MCP、已添加到注册项目的插件；首次使用为空，支持搜索和按类型筛选 | 「添加到项目…」（可多选项目）、克隆新仓库、新建 MCP 定义 |
| **矩阵** | 行为工具、列为项目的交叉表，一眼看出哪个工具在哪些项目里启用 | 单元格点击即启用或停用 |
| **体检** | 汇总所有项目的 doctor 结果，按级别分组 | 一键修复（只对能安全修复的项，比如重建断链） |
| **全局** | `~/.claude/skills` 中的全局 Skill、全局启用的插件，以及迁移建议 | 「移到项目级」向导：选择用到它的项目 → 在这些项目中添加 → 从全局移除 |

项目详情页示意：

```
┌ web-app ────────────────────────── 上下文 ≈ 6.1k tokens ▓▓▓▓▓░░ ┐
│ Agents: [x] Claude Code  [x] Cursor  [ ] Codex      ● doctor: 1 warn │
├───────────────┬───────────────────┬──────────────────────────────┤
│ Skills (2)    │ MCP (2)           │ 插件 (1)                      │
│ ☑ baoyu-comic │ ☑ figma    4.2k   │ ☑ security-guidance  0.3k    │
│   a1b2c3d 96  │   CC · Cursor     │   官方 marketplace           │
│ ☑ baoyu-cover │ ☑ playwright 1.4k │                              │
│   v1.2.0  88  │   CC              │                              │
│ [+ 添加]      │ [+ 添加]          │ [+ 添加]                      │
├───────────────┴───────────────────┴──────────────────────────────┤
│ ⚠ figma 与插件 figma@claude-plugins-official 自带的 MCP 同名      │
└──────────────────────────────────────────────────────────────────┘
```

### 9.3 本地 API

server 只是 core 的 HTTP 映射，与 CLI 命令一一对应：

| 方法与路径 | 对应命令 |
|---|---|
| `GET /api/projects` | 读注册表，附带每个项目的 `list` 摘要 |
| `GET /api/projects/:id` | `atm list --json` |
| `POST /api/projects/:id/tools` | `atm add …` |
| `DELETE /api/projects/:id/tools/:kind/:name` | `atm remove …` |
| `POST /api/projects/:id/install` | `atm install` |
| `GET /api/projects/:id/doctor?measure=1` | `atm doctor [--measure]` |
| `GET /api/library` | 读取共享目录、registry 和已添加插件；`includeInstalledPlugins=1` 仅用于主动添加时发现本机插件 |
| `POST /api/sync` | `atm sync` |
| `GET /api/events` | SSE：文件变化、长任务进度 |

写操作支持 `?dryRun=1`，返回将要写入的文件 diff，GUI 先展示 diff，用户确认后再提交。

### 9.4 实时与并发

- **实时刷新**：server 用 `fs.watch` 监听已注册项目的 `.agents/` 和各 Agent 配置文件，有变化就通过 SSE 推给前端。这样用户在 CLI 或 Agent 里改了配置，GUI 也会立即更新
- **并发写**：CLI 和 GUI 可能同时写同一个项目。core 的写操作统一加文件锁（`.agents/.lock`，带超时）；拿不到锁时返回「另一个 atm 进程正在写」
- **长任务**：clone、sync、`doctor --measure` 走异步任务，通过 SSE 报告进度，可以取消

### 9.5 安全

server 能读写本地文件、执行 git 和 MCP 命令，必须防止被网页利用：

1. 只监听 `127.0.0.1`，端口随机
2. 启动时生成随机 token，作为打开浏览器时的 URL 参数传入；之后所有请求都要在 header 中携带，否则返回 401
3. 校验 `Host` 和 `Origin` 头，防 DNS rebinding 和 CSRF
4. 环境变量和密钥只显示变量名和「已设置 / 未设置」，**任何接口都不返回密钥值**
5. 新建 MCP 定义时，`command` 字段在保存前需要用户确认（它会在本机执行任意命令）

### 9.6 技术选型

- 前端：React + Vite + TanStack Query；UI 组件用 shadcn/ui；不引入全局状态库
- server：Node 原生 `http` + 一个轻量路由（如 Hono），与 core 运行在同一进程
- 打包：前端构建产物放进 `cli` 包的 `dist/ui`，`atm ui` 直接托管，不需要单独安装

---

## 10. 错误处理原则

1. **不覆盖**：遇到用户手写的条目、实体目录或冲突的克隆目录时，一律报错，并给出 `--adopt` / `--force` 的提示
2. **原子写**：所有配置文件都先写临时文件再 rename；中途失败时清单和 lock 都不改
3. **不动共享仓库的状态**：除了 `sync` 中的 `pull --ff-only` 和 `pin` 建 worktree，atm 不对 `~/.agent-tools` 下的仓库执行 checkout、reset 或 stash
4. **报错可执行**：每条错误都附带下一步该执行的命令

---

## 11. 测试方案

| 层 | 内容 | 方式 |
|---|---|---|
| 单元 | SkillResolver 的三种目录结构、frontmatter 解析、合并写入算法、各 Adapter 渲染 | Vitest + 临时目录 fixture |
| 集成 | `init → add → remove → install` 全流程；在本地 bare repo 上模拟 clone / pull | 临时 `HOME` + 本地 git 仓库 |
| 快照 | 各 Adapter 生成的配置文件 | 快照测试 |
| API | 每个接口与对应 CLI 命令的结果一致；缺 token、错误 Origin 时被拒绝 | Vitest + supertest |
| GUI | 添加 → 查看 diff → 确认 → 矩阵更新；CLI 改动后 GUI 自动刷新 | Playwright |
| 端到端（手动） | 在真实项目中让 Claude Code 和 Cursor 识别出 Skill、MCP、插件 | 检查清单，每个版本发布前执行一次 |

---

## 12. 里程碑

| 阶段 | 范围 | 验收标准 | 工作量 |
|---|---|---|---|
| P0 | `init`、`add/remove skill`、`install`、`list`、基础 `doctor`；只支持 claude-code；入口 Skill | 对 Agent 说「把 baoyu-skills 里的 baoyu-comic 链接到当前项目」，新会话中可以触发该 Skill | 约半天 |
| P1 | McpRegistry、claude-code 与 cursor 的 MCP Adapter、合并写入、明文密钥扫描 | `atm add mcp figma` 后两个 Agent 都能调用；手写条目不受影响 | 1–2 天 |
| P2 | PluginIndex、`add plugin`、重复检测、全局→项目迁移建议 | `doctor` 能指出插件与清单中重复的 MCP | 约半天 |
| P3 | codex Adapter、`pin` / worktree、`doctor --measure` | 三个 Agent 共用一份清单 | 每项约半天 |
| P4 | GUI v1：server + 鉴权、总览、项目详情、工具库、diff 确认、SSE 刷新 | `atm ui` 中给项目添加 Skill 和 MCP，效果与 CLI 完全一致 | 2–3 天 |
| P5 | GUI 增强：矩阵、体检一键修复、全局→项目迁移向导 | 能在 GUI 中把一个全局插件迁移到它被用到的 2 个项目 | 1–2 天 |
| P6（可选） | Tauri 桌面壳、托盘 | 不开终端也能使用 | 约 2 天 |

P6 实现位于 `packages/desktop`：内置 Node 与 server/UI、托盘驻留、单实例、可选登录启动、服务恢复与退出清理。构建、发布和目标平台验收见 [desktop.md](./desktop.md)。

> P0–P3 的 core 必须先把 `--json` 输出和 `dryRun` 做好，P4 才能只做 UI 而不改动核心逻辑。

---

## 13. 待确认 / 待验证

1. Cursor 和 Codex 是否读取 `.agents/skills`，或者需要各自的入口软链
2. Cursor `mcp.json` 和 Codex `config.toml` 的环境变量引用语法
3. Codex 项目级配置与用户级配置同名时的合并行为
4. Claude Code 中项目 Skill 与全局 Skill 同名时的优先级
5. 与 `npx skills` 的兼容：两者都写 `.agents/skills/` 时，是否需要识别对方建的条目，避免误删
6. 已确认需要桌面应用（P6）；与本地 Web 并存，见 [desktop.md](./desktop.md)

## 共享仓库首次使用流程

新安装不导入示例项目、工具或本机插件。界面先检查 `GET /api/shared-repository`，未初始化时仅显示创建仓库入口。显式完成后配置记录 `sharedRepository: true`；更换根目录会清除此状态。旧配置、已添加工具均保留。

共享仓库接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/shared-repository` | 初始化状态、路径、远程、分支、待提交文件 |
| POST | `/api/shared-repository/init` | `{ root, mcpRegistry }` 创建目录与本地 Git，最后原子保存配置 |
| POST | `/api/shared-repository/tools` | `{ kind: skill/plugin, name, description, content }` 或 `{ kind: mcp, def }`，拒绝同名覆盖 |
| PUT | `/api/shared-repository/remote` | `{ remote }` 配置 origin |
| POST | `/api/shared-repository/commit` | `{ message }` 仅提交管理范围内文件，保留其他暂存改动 |
| POST | `/api/shared-repository/push` | 手动推送当前分支，无 force；失败保留本地提交 |

Skill 的共享仓库引用为 `atm:shared`，lock 路径为 `skills/<name>`。插件建立 `.claude-plugin/plugin.json` 和内置 Skill，marketplace 为 `atm-shared`。项目仅在 Claude Code 启用时写入该 marketplace 的绝对目录和 enabledPlugins；移除最后一个本地插件时，仅移除 lock 标记为管理的 marketplace 条目，保留手写设置。

目录初始化复用旧接口的目录校验与回滚；新增 Git 和默认文件失败时清理本次创建内容，配置不变。新工具内容可继续通过编辑器修改；共享目录文件监听刷新工具库。外置 MCP registry 保持原路径，界面明确提示不会随仓库推送。旧 `initSharedDirectory` 接口仍只创建目录，供现有客户端兼容。
