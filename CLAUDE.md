# atm (Agent Tool Manager)

pnpm monorepo. Node ≥ 20, TypeScript strict, ESM.

- `packages/core` — all business logic (`@atm/core`). Pure Node, runtime deps are `smol-toml` and `yauzl`.
- `packages/cli` — `atm` binary, thin wrapper over core.
- `packages/server` — Hono HTTP + SSE wrapper over core, serves the UI build.
- `packages/ui` — React + Vite + Tailwind v4 GUI. `VITE_ATM_MOCK=1` runs against in-memory mock data.
- `skill/agent-tools/SKILL.md` — the one globally-installed entry Skill.

Docs: `docs/tech-design.md` (design), `docs/implementation-contract.md` (binding interface contract between packages), `packages/core/src/types.ts` (shared types, must stay pure). Design prototypes in `design/`.

Commands: `pnpm build`, `pnpm test`, `pnpm typecheck` at root run across packages. Tests never touch the real `~` — core takes `home` / `env` overrides.

# pi 开发工具

Pi 在 `~/.pi/agent/` 加载了个人的 Web 搜索 / web 相关扩展与技能，本项目另提供以下 pi 工具（已信任项目后生效）：

- `.pi/extensions/` 加载后提供两个工具：`atm_check`（秒级静态检查包边界契约：core 依赖白名单、types.ts 纯类型、core 源码禁用模块、测试误用 os.homedir()；编辑 types.ts 后自动复检）与 `atm_sandbox`（在一次性临时 HOME 里跑本地构建的 `atm` CLI，可 seed 共享仓库，验证 init/add/doctor 落盘且不碰真实 ~）。改动 core/types.ts/依赖后先跑 `atm_check`。
- `.pi/skills/atm-dev/SKILL.md` 是各包命令速查与契约 red flags，写测试、跑 server/ui/desktop 前读它。
- `/atm-review`（`.pi/prompts/`）按 implementation-contract 审查未提交改动。
