# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Local developers and technical team members who manage tooling across multiple projects and coding agents. The primary use is a local developer workbench: a single operator working desktop-first, with the CLI, browser GUI, and desktop app as entry points. Users need to control which Skills, MCP servers, and Claude Code plugins each project loads without fragmented global configuration or unnecessary context cost.

## Product Purpose

`atm · Agent Tool Manager` centralizes Agent tooling through a project-level manifest and synchronizer. Each project declares its tools in `.agents/tools.json`; shared originals live in a Git repository, normally `~/.agent-tools`, and are linked or rendered into each agent's native configuration.

Success means a user can reproduce a project's tool setup, move tools between global and project scope, understand context cost, inspect differences, and repair configuration drift without manually maintaining every agent's generated files.

## Positioning

The differentiating mechanism is cross-agent synchronization combined with per-project context-cost accounting—not Skill symlinking alone. Shared Skill originals let one Git pull update many projects while preserving a direct upstream contribution path. Manifests and lockfiles make setups reproducible, while the workbench adds a project × tool matrix, generated-config-versus-disk diffs, health repair, version pinning, and global-to-project migration.

## Operating Context

- The product operates on a developer's real local projects and Agent configurations, not as a hosted multi-tenant service.
- Claude Code, Cursor, and Codex are supported Agent targets; plugins attach only to Claude Code-enabled projects.
- The local server uses loopback access, a bearer token, and Host/Origin checks. There are no accounts or permission roles.
- The React SPA is reused by the Tauri desktop app. The CLI, natural-language Agent commands, browser UI, and desktop app share the same core business logic.
- First run: create a shared Git repository, add or import a tool, add a project, associate tools through diff preview, and optionally configure an existing Git remote and manually commit or push.
- Consequential operations follow select → dry-run/diff → write, expose equivalent CLI commands and relevant safety flags, and preserve handwritten configuration through managed-entry merging.
- Filesystem changes and asynchronous tasks propagate through SSE into progress, activity, success, and error states.

## Capabilities and Constraints

- Overview, project detail, library, project × tool matrix, doctor, and local/global-tool surfaces support installation, removal, synchronization, version pinning, context measurement, inspection, migration, and repair workflows.
- Native files and directories, GitHub, npm/PyPI MCP identifiers, Agent Skills, MCP Registry, Claude marketplace, GitHub search, `.skill`, and ZIP are supported installation or import sources.
- Imports are preview-and-select. They do not execute imported scripts, automatically link projects, or automatically push Git changes. Current limits are 20 MB transferred, 50 MB expanded/installed, and 2,000 source entries.
- Required but not yet implemented in the production UI: global `⌘K` search and compact-density switching. Future work must treat both as product capabilities to preserve or complete, not optional prototype decoration.
- `@atm/core` is pure Node and owns business logic; the CLI is thin, Hono provides HTTP/SSE, and Tauri reuses the UI, server, and core. The UI uses React, React Router, TanStack Query, Vite, Tailwind, TypeScript, and Lucide.
- Secrets are represented by environment-variable references rather than hosted by the product. Generated configuration must not overwrite unrelated handwritten entries.
- Current packaged desktop distribution is macOS 14+ on Apple Silicon and is unsigned and unnotarized. Intel, Windows, and Linux installers are not currently provided.
- The official OS, browser, and minimum-viewport support matrix remains undecided. The Windows symlink support boundary and provisional Codex environment-variable syntax require explicit resolution before being presented as guaranteed compatibility.

## Brand Commitments

- Official browser name: lowercase `atm · Agent Tool Manager`. The shell uses `Agent Tools` with the Chinese tagline `集中管理，按需关联` and English tagline `One library. Every project.`
- Voice follows clear, concise, consistent communication. Chinese is the default UI language; English is available and persists across reloads. Paths, code, project/tool names, and raw diagnostics remain untranslated.
- The existing logo suite and its usage restrictions under `assets/logo/` are binding brand assets. Trademark clearance has not been performed and must not be claimed.

## Evidence on Hand

- `docs/feasibility.md` records one real machine audit with Skills spread across three managers, seven globally enabled plugins, and MCP fragmented across agents. This is a single-machine observation, not broad customer research.
- Product and interface evidence includes `README.md`, `docs/tech-design.md`, `docs/implementation-contract.md`, `design/v4/prototype/prototype.html`, current light/dark prototype captures, and implementation captures under `packages/ui/e2e/screenshots/`.
- Logo assets live under `assets/logo/`; favicon and touch icons live under `packages/ui/public/`.
- Mock projects, tools, and `/Users/dev` fixtures are demonstration data, not customer evidence.
- No personas, interview transcripts, testimonials, usage analytics, or broad customer-validation evidence were found. Future work must not fabricate them.

## Product Principles

1. Keep the local operator in control: preview consequential writes, preserve handwritten configuration, and avoid implicit script execution or Git pushes.
2. Make project tooling reproducible through declarative manifests, lockfiles, shared originals, and explicit synchronization.
3. Present one consistent product truth across CLI, browser, desktop, and each Agent's native configuration.
4. Make context cost, configuration drift, and repair options visible so users can decide what belongs in each project.
5. Treat safety constraints and unsupported environments as product facts, not fine print to obscure.

## Accessibility & Inclusion

WCAG 2.2 AA is the confirmed acceptance target. Existing keyboard operation, focus management, reduced-motion support, accessible dialogs, live regions, and synchronized document language are implementation signals, not a conformance claim; the interface still requires verification against the target.
