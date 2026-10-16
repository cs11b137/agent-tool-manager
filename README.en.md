<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/atm-logo-dark.svg">
    <img src="assets/logo/atm-logo.svg" alt="atm" height="72">
  </picture>
</p>

# atm · Agent Tool Manager

[简体中文](README.md) | **English**

Manage Skills, MCP servers, and Claude Code plugins in one place, then assign them to Claude Code, Cursor, and Codex projects through the desktop app, web UI, or CLI. Tools live in a shared Git repository (default: `~/.agent-tools`); each project declares its tools in `.agents/tools.json`. Skills use symbolic links, MCP definitions generate native agent configurations, and plugins are enabled per project.

[Download v0.2.0 · macOS Apple Silicon](https://github.com/cs11b137/agent-tool-manager/releases/download/v0.2.0/Agent-Tool-Manager_0.2.0_macos-arm64.dmg) · [Release notes](https://github.com/cs11b137/agent-tool-manager/releases/tag/v0.2.0) · [SHA-256 checksums](https://github.com/cs11b137/agent-tool-manager/releases/download/v0.2.0/SHA256SUMS.txt)

Requires macOS 14+ and an M-series chip. This desktop preview is not Apple Developer ID signed or notarized.

## New in v0.2.0

1. **Search and install**: Find tools in Agent Skills, MCP Registry, the Claude official plugin marketplace, and GitHub. Preview and select tools before installation.
2. **Multiple sources**: Import native Skill, MCP, and Plugin files or complete directories; install from GitHub repositories with optional revisions and subpaths, or use `.skill` / ZIP archives.
3. **Development reloads**: Backend source changes automatically rebuild and restart the service while preserving the session, keeping the UI and endpoints in sync.

The tool library starts empty until you add tools. Creating the shared directory does not import installed plugins automatically. Select installed plugins explicitly when adding tools to a project, or scan for them on the **Local tools** page.

## First-time setup

1. Create a shared Git repository. The default location is `~/.agent-tools`, with the MCP registry at `~/.agent-tools/mcp-registry`. The GUI requires this step before you can manage projects and tools.
2. In the tool library, choose **Search and install…**, **Download and install…**, **Upload package…**, or **New tool…**. Skills are saved to `skills/<name>/SKILL.md`; plugins go in `plugins/<name>/` and are registered in `.claude-plugin/marketplace.json`.
3. Add an existing project folder. This initializes its tool manifest and agent entry points.
4. Assign tools from the library to your projects. Preview the file changes before applying them.
5. In the Git section, enter an existing GitHub repository URL, then commit and push manually using your local Git identity and authentication. Failed pushes preserve local commits so you can fix the URL or credentials and retry.

Existing directory contents, tools, and explicitly configured paths are preserved. Changing a path does not move files or rebuild project links. Commits cover the README, gitignore, shared Skills, plugins, local MCP scripts (`.mcp-packages/`), and any MCP registry inside the shared repository. External registries, separately cloned repositories, and project files are excluded. Create the remote GitHub repository yourself; this feature does not create it automatically.

Path fields in repository settings, first-time setup, project registration, and project relocation support **Choose folder…** as well as absolute paths or `~/…`. Choosing a folder only fills the input; canceling preserves its value. To create a directory that does not exist yet, enter its path manually. Use settings to update the repository path, registry, and default agents; the library refreshes after a successful update. Folder dialogs open on the machine running the server: macOS and Windows use native dialogs, while Linux requires `zenity` or `kdialog`. Manual input remains available without a desktop environment.

Plugins can only be assigned to projects with Claude Code enabled. They use project-level `extraKnownMarketplaces` and `enabledPlugins`, with an absolute path for the local marketplace. Trust the project in Claude Code to load local plugins. If the client reports a missing installation, run `claude plugin install <name>@atm-shared --scope project`. See the [Claude Code documentation](https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository).

## Install third-party tools

In **Tool library**, choose **Search and install…**, **Download and install…**, or **Upload package…**. The dialog offers search, URL, GitHub, local file, and local directory inputs. Preview and select tools before confirming, then link installed tools to projects.

| Source | Supported content |
| --- | --- |
| Native files/directories | Skill `SKILL.md` with resources; MCP JSON (single definitions, `mcpServers`, VS Code `servers`, official `server.json`); Claude Code `.claude-plugin/plugin.json` with plugin resources |
| GitHub | `owner/repo`, repository, tree or blob URLs, with optional branch/tag/commit and subpath |
| MCP package identifiers | Enter `npm:@scope/package@version` or `pypi:package==version` in the URL field to generate npx / uvx launch configuration |
| Search | Agent Skills catalog, MCP Registry, Claude official plugin marketplace, and GitHub repository search |
| Archives | `.skill` and ZIP, containing one or multiple tools, with optional repository wrapper directory |

Import complete directories or GitHub paths for tools with resources. A standalone `plugin.json` is rejected if its referenced files are missing. Relative MCP scripts are copied with source files into the shared repository's `.mcp-packages/` directory and launch paths are rewritten; `node_modules` is excluded. npm / PyPI dependencies download when the agent first starts the MCP server, requiring Node.js / uv. Secrets use `${ENV_VAR}` references; preview warns about unset variables.

Limits: 20 MB per download/upload, 50 MB expanded source and selected installation, 2000 source entries. GitHub limits apply to the entire snapshot. Encrypted ZIPs, links, special files, unsafe and duplicate paths are rejected. Git metadata, dependency directories and system metadata are skipped. Existing tools are never overwritten; failed writes roll back; changed content requires a fresh preview. Installation does not execute scripts, link projects, or push commits. Failed search providers show warnings without discarding other results. Demo mode does not perform external installations.

## Navigation and language

The sidebar has three groups: Workspace, Projects, and Maintenance. Workspace includes Overview, Library, and Assignments. Projects supports searching and adding folders. Maintenance includes Health checks and Local tools. The shared repository card and the settings button open repository settings. On narrow screens, the menu button opens the full navigation.

Select **中文 / English** to switch the interface language. Your choice is stored in the current browser and survives reloads. Switching languages preserves the current route and unsaved form inputs. Project names, tool descriptions, file paths, source files, and raw diagnostic messages remain unchanged. Language controls are also available during first-time setup and in settings.

Navigation draws on [Carbon UI shell](https://www.carbondesignsystem.com/building-blocks/core/components/ui-shell-left-panel/guidelines), interface copy follows [Atlassian's writing principles](https://atlassian.design/foundations/content/voice-tone/), and language controls follow [W3C multilingual navigation guidance](https://www.w3.org/International/questions/qa-navigation-select): two levels of navigation, clear action labels, and visible language choices.

Additional documentation is currently in Chinese:

- [Technical design](docs/tech-design.md)
- [Implementation contract](docs/implementation-contract.md)
- [Design assets](design/)

## Installation and usage

### Desktop app

Download the [v0.2.0 installer](https://github.com/cs11b137/agent-tool-manager/releases/download/v0.2.0/Agent-Tool-Manager_0.2.0_macos-arm64.dmg), open the DMG, and drag the app into Applications. Requires macOS 14+ and Apple Silicon (M-series). The [release page](https://github.com/cs11b137/agent-tool-manager/releases/tag/v0.2.0) includes release notes and SHA-256 checksums.

The app bundles Node and the local server, so no terminal is needed to use it. It supports a system tray, single-instance operation, and optional launch at login. This preview is not signed with an Apple Developer ID or notarized, so macOS may block it from opening. Intel Mac, Windows, and Linux installers are not currently provided. Git operations still require a local Git installation; MCP dependencies and credentials must be configured separately.

To build from source, run `pnpm desktop:build`. Packages are generated in `packages/desktop/src-tauri/target/release/bundle/`. Use `pnpm desktop:dev` for desktop development. See the [desktop guide](docs/desktop.md) (Chinese).

### CLI and web UI from source

Building the full workspace requires Node 22+, pnpm 11, Rust 1.90+, and the Tauri build dependencies for your operating system. See the [desktop guide](docs/desktop.md) for build requirements.

```bash
pnpm install
pnpm -r build
node packages/cli/dist/bin.js --help      # Show CLI help
```

To use the `atm` command in the examples below, run `pnpm link --global` from `packages/cli`.

```bash
cd <project>
atm init                                  # Create .agents/, manifest, .claude/skills link, .gitignore
atm add skill jimliu/baoyu-skills baoyu-comic
atm add mcp figma --agents claude-code,cursor
atm add plugin security-guidance@claude-plugins-official
atm list
atm doctor [--measure]
atm install                               # Restore tools after cloning a project
atm sync                                  # Update shared repositories and lock files
atm ui                                    # Open the local GUI
```

All commands accept `--json` and `--dry-run`. Exit codes: `0` for success, `1` for an error, and `2` for invalid arguments.

The agent entry Skill is in [skill/agent-tools/SKILL.md](skill/agent-tools/SKILL.md). Link it to `~/.claude/skills/agent-tools`, then ask Claude Code to “link baoyu-comic from baoyu-skills into the current project.”

## Repository structure

| Package | Purpose |
|---|---|
| `packages/core` | `@atm/core`: manifests, resolution, adapters, health checks, and write operations that preview diffs before applying changes atomically |
| `packages/cli` | The `atm` command-line interface, a thin wrapper around core |
| `packages/server` | `@atm/server`: Hono HTTP API, SSE, token authentication, and static UI hosting |
| `packages/ui` | React + Vite + Tailwind GUI using the Liquid Glass design system |
| `packages/desktop` | Tauri desktop shell, bundled Node and server resources, tray, and process lifecycle management |
| `skill/agent-tools` | The only Skill that needs a global installation |

## Development

```bash
pnpm -r build
pnpm -r test                               # Vitest + Node integration tests for the desktop service
pnpm typecheck                            # Workspace type and syntax checks
pnpm --filter @atm/ui dev                  # Real local data + UI hot reload on port 5173
pnpm --filter @atm/ui dev:mock             # Explicit demo mode
pnpm --filter @atm/ui e2e                  # Playwright screenshots with mock data
pnpm --filter @atm/ui e2e:real             # Playwright with a real server and temporary HOME
pnpm --filter @atm/desktop check:rust      # Rust desktop shell tests
pnpm desktop:dev                          # Desktop development mode
pnpm desktop:build                        # Installer for the current platform
```

During development, open the token-bearing URL printed in the terminal. The default mode reads your real local configuration, registered projects, and tool library; UI write operations modify real files. `dev:mock` is for demos and does not write to your local tool configuration.

`dev` watches core/server sources and rebuilds and restarts the development stack when they change. Automatic restarts preserve the session token so the browser stays authenticated and uses current endpoints. UI sources still use hot module replacement.

Tests use temporary directories instead of your real home directory. Core accepts `home` and `env` overrides for fixtures.

## Security

- The server listens only on `127.0.0.1`, generates a new random token on each launch, and validates `Host` and `Origin`. Web mode uses a random port by default; desktop mode reuses its previous port when available and falls back to a free port on conflict.
- Use variable references such as `${VAR}` to avoid storing plaintext secrets in configuration. `doctor` scans for potential plaintext secrets.
- Configuration merging only changes entries tracked in the lock file's `managed` section, preserving handwritten configuration.
