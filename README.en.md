<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/atm-logo-dark.svg">
    <img src="assets/logo/atm-logo.svg" alt="atm" height="72">
  </picture>
</p>

# atm · Agent Tool Manager

[简体中文](README.md) | **English**

Declare the Skills, MCP servers, and plugins each project needs in a single manifest (`.agents/tools.json`). `atm` installs them in the native locations used by Claude Code, Cursor, and Codex. Skill repositories live in `~/.agent-tools`, with symbolic links in each project. Define MCP servers once and generate configuration for each agent. Enable plugins per project. A local GUI is included.

The tool library starts empty until you add tools. Creating the shared directory does not import installed plugins automatically. Select installed plugins explicitly when adding tools to a project, or scan for them on the **Local tools** page.

## First-time setup

1. Create a shared Git repository. The default location is `~/.agent-tools`, with the MCP registry at `~/.agent-tools/mcp-registry`. The GUI requires this step before you can manage projects and tools.
2. Create a Skill, MCP definition, or Claude Code plugin in the tool library. Skills are saved to `skills/<name>/SKILL.md`; plugins go in `plugins/<name>/` and are registered in `.claude-plugin/marketplace.json`.
3. Add an existing project folder. This initializes its tool manifest and agent entry points.
4. Assign tools from the library to your projects. Preview the file changes before applying them.
5. In the Git section, enter an existing GitHub repository URL, then commit and push manually using your local Git identity and authentication. Failed pushes preserve local commits so you can fix the URL or credentials and retry.

Existing directory contents, tools, and explicitly configured paths are preserved. Changing a path does not move files or rebuild project links. Commits cover the README, gitignore, shared Skills, plugins, and any MCP registry inside the shared repository. External registries, separately cloned repositories, and project files are excluded. Create the remote GitHub repository yourself; this feature does not create it automatically.

Path fields in repository settings, first-time setup, project registration, and project relocation support **Choose folder…** as well as absolute paths or `~/…`. Choosing a folder only fills the input; canceling preserves its value. To create a directory that does not exist yet, enter its path manually. Use settings to update the repository path, registry, and default agents; the library refreshes after a successful update. Folder dialogs open on the machine running the server: macOS and Windows use native dialogs, while Linux requires `zenity` or `kdialog`. Manual input remains available without a desktop environment.

Plugins can only be assigned to projects with Claude Code enabled. They use project-level `extraKnownMarketplaces` and `enabledPlugins`, with an absolute path for the local marketplace. Trust the project in Claude Code to load local plugins. If the client reports a missing installation, run `claude plugin install <name>@atm-shared --scope project`. See the [Claude Code documentation](https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository).

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

Download the desktop app from [GitHub Releases](https://github.com/cs11b137/agent-tool-manager/releases). The `v0.1.0` preview provides an installer for Apple Silicon Macs (M-series) running macOS 14 or later. Open the DMG and drag the app into Applications. A SHA-256 checksum file is included on the release page.

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

Tests use temporary directories instead of your real home directory. Core accepts `home` and `env` overrides for fixtures.

## Security

- The server listens only on `127.0.0.1`, generates a new random token on each launch, and validates `Host` and `Origin`. Web mode uses a random port by default; desktop mode reuses its previous port when available and falls back to a free port on conflict.
- Use variable references such as `${VAR}` to avoid storing plaintext secrets in configuration. `doctor` scans for potential plaintext secrets.
- Configuration merging only changes entries tracked in the lock file's `managed` section, preserving handwritten configuration.
