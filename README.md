<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/atm-logo-dark.svg">
    <img src="assets/logo/atm-logo.svg" alt="atm" height="72">
  </picture>
</p>

# atm · Agent Tool Manager

每个项目用一份清单（`.agents/tools.json`）声明所需的 Skill / MCP / 插件，`atm` 把它们落地到各 Agent（Claude Code、Cursor、Codex）的原生位置。Skill 原件统一克隆到 `~/.agent-tools`，项目内只放软链；MCP 只定义一次，渲染成各家格式；插件按项目启用。附带本地 GUI。

首次打开且尚未添加工具时，工具库为空；只初始化目录也不会自动导入本机插件。已安装插件在项目的「添加工具」中主动选择，「全局」页面需点击扫描后才展示本机工具。

首次使用按以下流程操作：

1. 创建共享 Git 仓库，默认 `~/.agent-tools`，MCP registry 默认 `~/.agent-tools/mcp-registry`。未完成前界面不开放项目与工具操作。
2. 在工具库新建 Skill、MCP 或 Claude Code 插件。Skill 保存到 `skills/<name>/SKILL.md`；插件保存到 `plugins/<name>/`，并登记 `.claude-plugin/marketplace.json`。
3. 添加已有项目目录，自动初始化工具清单和 Agent 入口。
4. 在工具库选择项目关联工具，预览文件差异后写入。
5. 在 Git 区域填写已有 GitHub 仓库地址，手动提交、推送；使用本机 Git 身份及认证。推送失败保留本地提交，可修正地址或认证后重试。

已有目录内容、工具和显式配置路径保留；更换路径不迁移文件或重建项目软链。提交范围为 README、gitignore、共享 Skills、插件及仓库内的 MCP registry；外部 registry、外部克隆仓库和项目文件不随该操作提交。GitHub 仓库需自行创建，本功能不会自动发布。

设置中的「更新仓库」、首次创建仓库、注册项目和重新定位的路径输入框支持「选择文件夹…」，也可手动输入绝对路径或 `~/…`。选择只回填路径，取消不修改输入；尚不存在的目录可手动输入后创建。工具库和设置不再提供重复初始化入口；后续通过设置更新仓库路径、registry 和默认 Agent，成功后刷新工具库。选择窗口在运行服务端的本机打开：macOS 和 Windows 使用系统窗口，Linux 需要 `zenity` 或 `kdialog`；没有桌面环境时可继续手动输入。

插件仅关联 Claude Code 项目，写入项目级 `extraKnownMarketplaces` 和 `enabledPlugins`；本地 marketplace 使用绝对路径。在 Claude Code 中信任项目后加载本地插件，如客户端提示未安装，可运行 `claude plugin install <name>@atm-shared --scope project`。参见 [Claude Code 官方说明](https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository)。

### 导航与语言

侧边栏按「工作区 → 项目 → 维护」分组：工作区包含总览、工具库、工具关联；项目区支持搜索和添加文件夹；维护区包含健康检查、本机工具。顶部的共享仓库卡片和底部设置均可打开更新仓库弹框。窄屏通过菜单按钮打开完整导航。

点击「中文 / English」即可切换界面语言，选择保存在当前浏览器中，刷新后仍有效。切换保留当前路由和未提交输入；项目名称、工具描述、文件路径、源文件和原始诊断信息保持原文。首次创建仓库和设置弹框也提供语言切换。

导航参考 [Carbon UI shell](https://www.carbondesignsystem.com/building-blocks/core/components/ui-shell-left-panel/guidelines)，文案遵循 [Atlassian 清晰、简洁、一致的写作原则](https://atlassian.design/foundations/content/voice-tone/)，语言入口参考 [W3C 多语言导航建议](https://www.w3.org/International/questions/qa-navigation-select)。本项目将这些原则落实为两层导航、明确动作名称和常显语言按钮。


- 技术方案：[docs/tech-design.md](docs/tech-design.md)
- 包间契约：[docs/implementation-contract.md](docs/implementation-contract.md)
- 设计稿：[design/](design/)

## 安装与使用

桌面版：`pnpm desktop:build` 生成当前平台安装包，产物位于 `packages/desktop/src-tauri/target/release/bundle/`。应用内置 Node 和本地服务，双击打开即可使用，支持托盘、单实例和可选登录启动。开发使用 `pnpm desktop:dev`。详见 [桌面版说明](docs/desktop.md)。

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
pnpm --filter @atm/ui dev                  # 真实本机数据 + GUI 热更新（5173 端口）
pnpm --filter @atm/ui dev:mock             # 显式使用演示数据
pnpm --filter @atm/ui e2e                  # Playwright，mock 模式截图
pnpm --filter @atm/ui e2e:real             # Playwright，真实 server + 临时 HOME
```

开发时使用终端打印的带 token 链接打开页面；默认读取本机配置、已注册项目和工具库，界面写操作会修改真实文件。`dev:mock` 仅用于演示，不写本机工具配置。

测试从不碰真实的 `~`：core 接受 `home` / `env` 覆盖，所有 fixture 在临时目录中。

## 安全

- server 只监听 `127.0.0.1`、随机端口、随机 token，校验 `Host` / `Origin`
- 配置文件只写 `${VAR}` 变量引用；任何接口都不返回密钥值；`doctor` 扫描明文密钥
- 合并写入只改动 lock `managed` 中列出的条目，手写配置不受影响
