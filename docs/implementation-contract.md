# atm 实现契约

> 日期：2026-10-12 · 上游文档：[tech-design.md](./tech-design.md) · 类型来源：`packages/core/src/types.ts`
>
> 本文是各包之间的接口约定。core / cli / server / ui 由不同的人并行实现，**以本文和 `types.ts` 为准**；发现与 tech-design.md 冲突时，本文优先并在这里记录差异。

## 1. 仓库布局与包归属

```
packages/
  core/     @atm/core    纯 Node，无 CLI/HTTP 依赖。所有业务逻辑。
  cli/      atm          commander 式参数解析 → core → 文本 / --json
  server/   @atm/server  Hono + Node http，core 的 HTTP 映射 + SSE + 鉴权
  ui/       @atm/ui      React 19 + Vite + Tailwind v4，构建产物复制到 cli/dist/ui
```

- 根目录：`pnpm-workspace.yaml`、`package.json`、`tsconfig.base.json`。各包只改自己目录；需要改根文件时只做**追加**。
- 所有包 `"type": "module"`，TypeScript strict，`verbatimModuleSyntax`。
- 测试：Vitest。core 用临时目录（`fs.mkdtemp`）+ 临时 `HOME` 做 fixture，**不碰真实 `~`**。
- `packages/core/src/types.ts` 是纯类型文件；ui 通过 `import type { … } from '@atm/core/types'` 引用。

## 2. core 公共 API

```ts
import { createAtm } from '@atm/core';

const atm = createAtm({
  home?: string;        // 覆盖 os.homedir()，测试用
  env?: NodeJS.ProcessEnv; // 覆盖 process.env，测试用
  configPath?: string;  // 覆盖 ~/.config/atm/config.json
  onEvent?: (e: AtmEvent) => void;
  signal?: AbortSignal;
});
```

`Atm` 接口（全部返回 Promise，类型见 `types.ts`）：

| 方法 | 对应命令 | 说明 |
|---|---|---|
| `config()` / `saveConfig(patch)` | — | 读写全局配置，缺省值：`root=~/GitHub`、`mcpRegistry=<root>/mcp-registry`、`defaultAgents=['claude-code']` |
| `projects()` | — | 注册表里每个项目的 `ProjectSummary`；目录不存在 → `exists:false`，其余字段取零值 |
| `registerProject(dir)` / `unregisterProject(idOrDir)` / `relocateProject(id, newDir)` | — | 注册表维护；`init` 和任何写操作自动调用 `registerProject` |
| `resolveProject(idOrDir)` | — | 把 id 或路径解析成绝对路径；找不到抛 `NOT_FOUND` |
| `init(dir, opts?: WriteOptions)` | `atm init` | 建 `.agents/tools.json`（agents 取 `defaultAgents`）、`.agents/skills/`、`.claude/skills` 软链、追加 `.gitignore`；已有 `.claude/skills` 实体目录时迁移，冲突抛 `CONFLICT` |
| `add(dir, spec: AddSpec, opts?: WriteOptions)` | `atm add …` | 解析 → 写清单 → 落地 → 更新 lock。`dryRun` 时返回同样的 `files` 但不写盘 |
| `remove(dir, name, opts?: WriteOptions & { kind?: ToolKind })` | `atm remove` | 不传 kind 时自动判断；同名跨类型抛 `AMBIGUOUS` |
| `install(dir, opts?: InstallOptions)` | `atm install` | 按清单全量还原，幂等 |
| `sync(repos?: string[], opts?)` | `atm sync` | 对涉及的仓库 `git pull --ff-only`；dirty 跳过；更新引用该仓库的所有已注册项目的 lock |
| `list(dir)` | `atm list --json` | `ProjectDetail`；包含一次不带 measure 的 doctor 结果（`issues`） |
| `doctor(target: string \| 'all', opts?: { measure?: boolean })` | `atm doctor` | `DoctorReport` |
| `fix(issueIds: string[], opts?: WriteOptions)` | GUI 一键修复 | 只处理 `fixable:true` 的 issue（重建软链 = 对该项目执行 install 的 skill 部分） |
| `measure(dir, mcpName)` | `doctor --measure` 单项 | 启动 MCP server，`tools/list`，统计 schema token，写回 lock |
| `pin(dir, skillName, rev)` | `atm pin` | 建 `<root>/.worktrees/<repo>@<rev>` worktree，软链改指向它 |
| `library()` | GUI 工具库 | 扫描 `<root>/**/SKILL.md`、registry、项目内 `.agents/mcp/`、`installed_plugins.json` |
| `search(query)` | `atm search` | 对 `library()` 做模糊匹配（name / repo / description） |
| `repos()` | — | `RepoStatus[]`：`<root>` 下所有 git 仓库 |
| `cloneRepo(repo)` | GUI「克隆仓库」 | clone 到 `<root>/<repoName>`，重名抛 `CONFLICT` |
| `saveMcpDef(def, scope: 'registry' \| { projectDir })` | GUI「新建 MCP 定义」 | 校验后写 `<name>.json` |
| `global()` | GUI 全局页 | `GlobalReport` |
| `migrate(spec: MigrateSpec, opts?: WriteOptions)` | GUI 迁移向导 | 对每个项目执行 add，再按需从全局移除 |
| `batch(ops: BatchOp[], opts?: WriteOptions)` | GUI 矩阵 | 逐项执行，单项失败不影响其他；返回 `BatchResult` |
| `diffGenerated(dir)` | GUI「查看生成的配置」 | 清单渲染结果 vs 磁盘现状的 `FileChange[]`（全部为 dryRun） |
| `watch(dirs, cb)` | server 用 | `fs.watch` 已注册项目的 `.agents/` 与各 Agent 配置文件、registry 目录；返回 `() => void` |

### 2.1 关键行为约定

- **项目 id**：`sha1(absolutePath).slice(0, 12)`。`atm.projectId(path)` 导出。
- **写操作一律先算 `FileChange[]` 再落盘**。`dryRun=true` 时只返回变更；`applied=false`。每个写操作内部流程：`plan() → (dryRun ? return : apply(plan))`。apply 用临时文件 + rename，先写 Agent 配置，最后写清单和 lock；任一步失败则回滚已写文件（保留 `before` 内容）。
- **文件锁**：apply 期间持有 `.agents/.lock`（`O_EXCL` 创建，内容为 pid + 时间，30s 超时视为过期）。拿不到锁抛 `LOCKED`。
- **错误**：抛 `AtmError`（`class AtmError extends Error { code: AtmErrorCode; nextCommand?: string; candidates?: string[]; toJSON(): AtmErrorJson }`）。每条错误都带 `nextCommand`。
- **合并写入**（§6.4）：只改 `lock.managed[agent]` 里列出的条目；遇到同名手写条目且非 `adopt` → `CONFLICT`。写 JSON 时保留原文件缩进（检测前两行缩进，默认 2 空格）；TOML 用 `smol-toml` 解析再序列化，手写注释会丢失，接受。
- **Adapter 行为**：

| Adapter | Skill 入口 | MCP | 变量写法 | 插件 |
|---|---|---|---|---|
| claude-code | `.claude/skills → ../.agents/skills`（相对软链） | `.mcp.json` `mcpServers` | `${VAR}` | `.claude/settings.json` `enabledPlugins[name]=true` |
| cursor | `.cursor/skills → ../.agents/skills` | `.cursor/mcp.json` `mcpServers` | `${env:VAR}` | 无 |
| codex | 不建软链（`.agents/skills` 原生读取） | `.codex/config.toml` `[mcp_servers.<name>]`；stdio 用 `command/args/env`，http 用 `url` + `http_headers` | `$VAR`（env 表的值原样写 `${VAR}` 转成 `$VAR` 形式） | 无 |

  项目内软链一律用**绝对路径**指向 `<root>/…`；`.claude/skills` 这种入口软链用相对路径。
- **Skill 发现**：`glob **/SKILL.md`，跳过 `node_modules`、`.git`、`.worktrees`；frontmatter 用极简 YAML 解析（只支持 `key: value` 与引号字符串，不引入 yaml 依赖）。结果按仓库 HEAD 缓存到 `~/.config/atm/cache/<repoName>.json`。
- **上下文估算**：`estimateTokens(text)`：ASCII 字符数 ÷ 4 + CJK 字符数 ÷ 1.5，四舍五入。Skill 取 `name + description`；MCP 未测量为 null；插件 = 内含 skill 之和 + 内含 MCP（若已测量）。
- **密钥扫描**：`env` / `headers` 值不匹配 `/\$\{[A-Z0-9_]+\}/`、`${env:VAR}`、`$VAR`，且 key 名含 `KEY|TOKEN|SECRET|PASSWORD` → `plaintext-secret`。扫描对象：registry 定义、项目内定义、各 Agent 已生成的配置文件（含手写条目）。
- **git**：通过 `child_process.execFile('git', …)` 调用，不引入依赖。所有 git 调用集中在 `git.ts`，便于测试 mock。
- **MCP measure**：仅实现 stdio transport（spawn command，JSON-RPC over stdin/stdout，发 `initialize` → `tools/list`，15s 超时）；http transport 用 fetch POST（Streamable HTTP）；失败抛 `GIT_FAILED` 以外的 `UNSUPPORTED`/错误并保持 lock 不变。
- **PluginIndex**：读 `~/.claude/plugins/installed_plugins.json`（version 2 格式：`plugins[name] = [{ scope, installPath, version }]`），展开 `installPath` 下 `skills/**/SKILL.md`、`.mcp.json`、`commands/*.md`、`agents/*.md`、`hooks/`。全局启用插件读 `~/.claude/settings.json` 的 `enabledPlugins`。

### 2.2 core 内部模块（建议，不是硬性要求）

```
src/
  index.ts          createAtm, AtmError, projectId, estimateTokens, 导出 types
  types.ts          （已存在，不要改动已有字段；可追加）
  errors.ts
  config.ts         GlobalConfig 读写 + 项目注册表
  manifest.ts       tools.json / tools.lock.json 读写 + 校验
  skills/resolver.ts, skills/discover.ts, skills/frontmatter.ts
  mcp/registry.ts, mcp/measure.ts, mcp/secrets.ts
  plugins/index.ts
  adapters/{types,claude-code,cursor,codex,merge}.ts
  ops/{init,add,remove,install,sync,list,doctor,fix,pin,library,global,migrate,batch}.ts
  fs/{atomic,lock,diff,symlink}.ts
  git.ts, tokens.ts, watch.ts
```

## 3. CLI（`packages/cli`）

- 可执行名 `atm`；`atm ui` 启动 server 并打开浏览器。
- 子命令与参数严格按 tech-design §7；所有命令支持 `--json`、`--dry-run`、`--adopt`、`--force`、`--strict`（install）、`--agents a,b`（add mcp）、`--measure`（doctor）。
- 退出码：0 成功 / 1 有 error / 2 参数错误。`--json` 模式下错误体就是 `AtmErrorJson`。
- 非 `--json` 的文本输出要简短、带颜色（只用 ANSI 码，不引依赖）；dryRun 时打印 unified diff。
- `atm ui [--port N] [--no-open]`：随机端口（127.0.0.1），打印带 token 的 URL。
- 入口 Skill `skill/agent-tools/SKILL.md` 放在仓库根目录 `skill/`（技术方案 §8），内容按 §8。

## 4. HTTP API（`packages/server`）

所有响应 `application/json`。错误：HTTP 4xx/5xx + `AtmErrorJson` 体（`LOCKED`→409、`CONFLICT`→409、`NOT_FOUND`→404、`INVALID_*`→400、其他→500）。

**鉴权**：启动时生成 32 字节随机 token。UI 首次通过 `?token=` 打开，之后请求头 `Authorization: Bearer <token>`；`/api/events` 允许 `?token=` 查询参数（EventSource 不能带 header）。缺失或错误 → 401。校验 `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`；有 `Origin` 时必须匹配。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/config` | | `GlobalConfig`（不含密钥，本来也没有） |
| PATCH | `/api/config` | `Partial<GlobalConfig>` | `GlobalConfig` |
| GET | `/api/projects` | | `ProjectSummary[]` |
| POST | `/api/projects` | `{ path }` | `ProjectSummary`（注册，不 init） |
| DELETE | `/api/projects/:id` | | `{ ok: true }` |
| PATCH | `/api/projects/:id` | `{ path?: string; agents?: AgentId[] }` | `ProjectDetail`（relocate / 改 agents，改 agents 走 install 的 dryRun 流程，支持 `?dryRun=1`） |
| GET | `/api/projects/:id` | | `ProjectDetail` |
| POST | `/api/projects/:id/init` | `WriteOptions` | `WriteResult` |
| POST | `/api/projects/:id/tools?dryRun=1&adopt=1` | `AddSpec` | `WriteResult` |
| DELETE | `/api/projects/:id/tools/:kind/:name?dryRun=1` | | `WriteResult` |
| POST | `/api/projects/:id/install?dryRun=1&strict=1` | | `WriteResult` |
| GET | `/api/projects/:id/generated` | | `FileChange[]`（`diffGenerated`） |
| GET | `/api/projects/:id/doctor?measure=1` | | `DoctorReport`（measure 时为长任务：返回 `{ taskId }`，结果走 SSE） |
| POST | `/api/projects/:id/measure/:name` | | `{ taskId }` |
| POST | `/api/projects/:id/pin` | `{ skill, rev }` | `WriteResult` |
| GET | `/api/doctor?measure=1` | | 全部项目的 `DoctorReport` |
| POST | `/api/doctor/fix?dryRun=1` | `{ issueIds: string[] }` | `WriteResult` |
| GET | `/api/library?q=` | | `LibraryItem[]` |
| GET | `/api/repos` | | `RepoStatus[]` |
| POST | `/api/repos` | `{ repo }` | `{ taskId }`（clone 是长任务） |
| POST | `/api/sync` | `{ repos?: string[] }` | `{ taskId }` |
| POST | `/api/mcp-defs` | `{ def: McpDef; scope: 'registry' \| { projectId } }` | `{ path }` |
| POST | `/api/batch?dryRun=1` | `{ ops: BatchOp[] }` | `BatchResult` |
| GET | `/api/global` | | `GlobalReport` |
| POST | `/api/global/migrate?dryRun=1` | `MigrateSpec` | `WriteResult` |
| GET | `/api/activity` | | `ActivityEntry[]`（最近 50 条，进程内） |
| GET | `/api/tasks/:id` | | `{ id, title, status, progress?, result?, error? }` |
| DELETE | `/api/tasks/:id` | | 取消 |
| GET | `/api/events?token=` | | SSE，`data: <AtmEvent JSON>`；每 25s 发 `: ping` |
| GET | `/*` | | 托管 ui 构建产物（SPA fallback 到 `index.html`） |

## 5. UI（`packages/ui`）

- 路由：`/`（总览）、`/projects/:id`（项目详情）、`/library`（工具库）、`/matrix`（矩阵）、`/doctor`（体检）、`/global`（全局）。
- 数据层：`src/api/client.ts` 实现 `ApiClient` 接口（方法与 §4 一一对应）；`src/api/mock.ts` 实现同一接口返回原型中的示例数据。`VITE_ATM_MOCK=1` 或 URL 无 token 且非 dev server 时用 mock。TanStack Query 做缓存；SSE `project.changed` → invalidate 对应查询。
- token 从 `?token=` 读出后存 `sessionStorage`，并从 URL 中移除。
- 设计系统：按 `design/liquid-glass/Main.dc.html` 的 CSS 变量与组件样式还原（亮 / 暗两套 token、玻璃材质、彩虹描边、动效时长）。`prefers-reduced-motion` 时关闭背景光斑动画。
- 添加工具 / 批量改动 / 一键修复 / 迁移向导等所有写操作：先 `dryRun=1` 展示 diff（原型 03），确认后再提交。

## 6. 与 tech-design.md 的差异记录

1. `tools.lock.json` 的 `skills[name]` 增加可选 `rev`、`worktree` 字段，供 `pin` 使用。
2. Codex 的变量引用暂定 `$VAR`（§13 待验证项）；实现放在单个函数里，便于后续改。
3. doctor 增加 `missing-link`、`plugin-not-installed`、`rev-mismatch`、`project-missing` 四个检查项。
4. 新增 `GET /api/projects/:id/generated`、`/api/batch`、`/api/global`、`/api/activity`、`/api/tasks` 等接口，服务矩阵页、全局页、总览「最近变更」。
