# Agent Tool 管理工具 · 产品可行性分析

> 范围：Skill + MCP + 插件 · 日期：2026-10-12

## 结论

| 对象 | 可行性 | 工具的价值 |
|---|---|---|
| Skill | 高：软链即可 | 中：`npx skills` 已覆盖大部分；剩余差异是统一克隆 + 上游 PR 回流 |
| MCP | 高：但只能**生成配置**，不能软链 | **最高**：最耗上下文、各 Agent 格式不同、密钥要管 |
| 插件 | 高：Claude Code 原生支持项目级启用 | 低：工具只做统一视图 + 一键开关 |

**定位**：做成"项目级 Agent 工具清单（manifest）+ 同步器"。用一个 `.agents/tools.json` 声明项目需要哪些 Skill / MCP / 插件，由工具落地到各 Agent 的原生位置。差异化来自 **MCP 跨 Agent 同步** 和 **按项目统计上下文占用**，不是软链本身。

---

## 0. 统一模型：大脑 + 手脚 + 工具

可以统一，但"工具"内部要分层，不能拍平。

| 层 | 是什么 | 例子 |
|---|---|---|
| 大脑 | 大模型，负责决策 | Opus、GPT |
| 手脚 | Agent 运行时，负责执行循环、读写文件、调用工具 | Claude Code、Codex、Cursor |
| 工具 · 能力（能做什么） | 新增动作 | MCP server、CLI 命令 |
| 工具 · 技能（怎么做） | 按需加载的说明书/流程，本身不增加动作 | Skill |
| 工具 · 工具箱（打包分发） | 把能力 + 技能 + hooks + 命令装在一起 | 插件 |

不能拍平的原因是**加载方式和上下文成本不同**：
- MCP：加载即注册工具 schema，常驻上下文
- Skill：只常驻一行描述，触发后才读全文
- 插件：容器本身不占上下文，占的是它装进来的东西

统一数据模型：

```ts
Tool {
  kind: "capability" | "skill" | "bundle"
  source: string            // git 仓库 / registry 名称 / marketplace
  scope: "global" | "project"
  context_cost: number      // 估算的常驻 token
  agents: string[]          // claude-code, cursor, codex ...
}
```

- **统一管理**：一个清单，一套 add / remove / install / sync / doctor
- **分开落地**：skill → 软链；capability → 渲染配置；bundle → 启用插件并展开其内容

---

## 1. 现状（本机已核实）

- **Skill**：`~/.claude/skills/` 有 7 个，全是软链，分别指向 3 个管理器（`~/.skilldock`、`~/.skills-manager`、`~/.codex/skills`）
- **插件**：`~/.claude/settings.json` 全局启用了 7 个插件，其中 figma、chrome-devtools 自带 MCP
- **MCP**：Claude Code 没有单独配置的 MCP，全部由插件带入；Codex `config.toml` 有 2 个（computer-use、node_repl）；Cursor `mcp.json` 为空
- `~/GitHub` 目录还不存在

碎片化已经真实发生：Skill 分散在 3 个管理器，MCP 分散在 3 个 Agent。

---

## 2. 需求成立吗？成立，而且 MCP 比 Skill 更痛

- **Skill**：每个描述常驻约 50–150 token，30 个 ≈ 1.5k–4.5k token；描述越多越容易误触发
- **MCP**：每个 server 的工具 schema 可达数千 token。Claude Code 的延迟加载缓解了一部分，其他 Agent 不一定有
- **插件**：一个插件可能同时带进多个 Skill + MCP，全局启用 7 个意味着更大的隐性占用

---

## 3. 三类对象的落地方式

### Skill
- 统一克隆：`~/GitHub/<repo>`（例如 `~/GitHub/baoyu-skills`）
- 项目内软链：`.agents/skills/baoyu-comic → ~/GitHub/baoyu-skills/skills/baoyu-comic`
- Claude Code 入口（一次）：`.claude/skills → .agents/skills`
- 发现逻辑：递归查找 `SKILL.md`。本机已出现 3 种目录结构（`x/`、`skills/x/`、`skills/productivity/x/`）
- 好处：`git pull` 一次所有项目同步更新；在项目里改的就是原件，可直接提 PR 给上游

### MCP
- MCP 是**一段 JSON/TOML 配置**，不是目录，所以不能软链，只能"从清单生成"
- 各 Agent 的项目级位置：

| Agent | 项目级 MCP 配置 |
|---|---|
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| Codex | `.codex/config.toml`（仅限受信任项目；与用户级配置的合并规则文档未说明） |

- 统一仓库的对应物：`~/GitHub/mcp-registry/<name>.json`，每个 server 只定义一次；项目清单只引用名字，工具渲染成各家格式
- 密钥：清单里只写 `${FIGMA_TOKEN}` 这类变量引用，真实值放 `.env`（gitignore）或系统钥匙串

### 插件
- Claude Code 插件 = Skill + 命令 + agents + hooks + MCP 的打包，原生支持在项目级 `.claude/settings.json` 的 `enabledPlugins` 中启用
- 支持本地 marketplace，可以指向 `~/GitHub` 下的仓库，同样能做到"pull 一次全项目更新"
- 工具只需要做三件事：把全局启用迁移到项目启用、列出每个插件带进了哪些 MCP/Skill、提示与单独安装的工具重复

---

## 4. 风险（按严重度排序）

1. **团队不可复现**：软链指向 `~/GitHub` 绝对路径，提交到 git 后别人机器上全是断链
   → 只提交 `tools.json`；软链和生成的配置加入 gitignore；用 `install` 还原
2. **MCP 密钥泄漏**：生成的 `.mcp.json` 含明文 token 被提交
   → 只允许变量引用；`doctor` 扫描明文
3. **无版本锁定**："pull 一次所有项目同步更新"也意味着"pull 一次所有项目一起坏"
   → lock 文件记录 commit sha，支持 pin
4. **覆盖用户手写配置**：`.mcp.json` / `settings.json` 可能已有手写内容
   → 只管理带标记的条目，合并写入，不覆盖
5. **重复与冲突**：插件自带的 MCP 和单独安装的 MCP 同名；项目 Skill 和全局 Skill 同名
   → `doctor` 提示

其他：
- 修改原件会同时影响所有项目
- 断链时静默失效，Agent 只是"找不到"，不报错
- 多 Agent 的读取路径和格式差异需要逐个验证
- Windows 软链需要开发者模式；首版只支持 macOS/Linux

---

## 5. 竞品与替代

| 工具 | 覆盖 | 与本方案的关系 |
|---|---|---|
| `npx skills`（vercel-labs/skills） | Skill；默认项目级；推荐软链模式；支持 Claude Code、Codex、Cursor 等几十个 Agent | **重叠度最高**。软链的原件放在项目内，不是共享克隆，所以没有"一次 pull 全项目更新 / 直接给上游提 PR"。不管 MCP，也不管插件；lock 文件文档里未说明 |
| skilldock、skills-manager | Skill（偏全局） | 本机已安装，侧重全局管理 |
| Claude Code `/plugin` | 插件 | 原生已覆盖大部分 |
| MCP 配置同步类工具 | MCP | 多为全局安装；**项目级 + 跨 Agent + 清单驱动**的组合较少，可以从这里切入 |

建议：Skill 部分与 `npx skills` 的目录约定（`.agents/skills`）保持兼容，不重复造轮子；主要投入放在 MCP 和统一清单上。

---

## 6. 推荐 MVP

形态：一个 Skill（`agent-tools/SKILL.md`）+ 一个 Node 脚本。Agent 听到「给当前项目加上 figma 的 MCP」「把 baoyu-skills 里的 baoyu-comic 链接进来」时调用脚本，用户不用记命令。

清单 `.agents/tools.json`：

```json
{
  "skills":  [{ "repo": "github.com/jimliu/baoyu-skills", "path": "skills/baoyu-comic", "rev": "main" }],
  "mcp":     ["figma", "playwright"],
  "plugins": ["security-guidance@claude-plugins-official"],
  "agents":  ["claude-code", "cursor"]
}
```

命令（5 个）：

1. `add skill|mcp|plugin <name>`：写入清单并立即落地
2. `remove <name>`
3. `install`：按清单还原（克隆缺失仓库、建软链、渲染各 Agent 的 MCP 配置、写 enabledPlugins）
4. `sync`：拉取涉及的仓库，更新 lock
5. `doctor`：检查断链、重名、明文密钥、仓库未提交改动、可从全局改为项目级的插件，并估算本项目工具的总上下文占用

分期与工作量：

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | Skill + Claude Code：软链、清单、install、doctor | 约半天 |
| P1 | MCP：registry、渲染 Claude Code `.mcp.json` 和 Cursor 配置、密钥变量、合并写入 | 约 1–2 天 |
| P2 | 插件：项目级 enabledPlugins、展开插件内含的 MCP/Skill、全局→项目迁移建议 | 约半天 |
| P3 | Codex / Gemini 适配、lock/pin | 每个 Agent 约半天 |

---

## 7. 待验证

- 实测：在测试项目中分别建一个软链 Skill、一条 `.mcp.json`、一个项目级插件，在 Claude Code 和 Cursor 中确认都能被识别
- Codex 项目级配置与用户级配置同名时的合并行为
- `npx skills` 的 lock 机制细节
