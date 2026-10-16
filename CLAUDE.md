# atm (Agent Tool Manager)

pnpm monorepo. Node ≥ 20, TypeScript strict, ESM.

- `packages/core` — all business logic (`@atm/core`). Pure Node, runtime deps are `smol-toml` and `yauzl`.
- `packages/cli` — `atm` binary, thin wrapper over core.
- `packages/server` — Hono HTTP + SSE wrapper over core, serves the UI build.
- `packages/ui` — React + Vite + Tailwind v4 GUI. `VITE_ATM_MOCK=1` runs against in-memory mock data.
- `skill/agent-tools/SKILL.md` — the one globally-installed entry Skill.

Docs: `docs/tech-design.md` (design), `docs/implementation-contract.md` (binding interface contract between packages), `packages/core/src/types.ts` (shared types, must stay pure). Design prototypes in `design/`.

Commands: `pnpm build`, `pnpm test`, `pnpm typecheck` at root run across packages. Tests never touch the real `~` — core takes `home` / `env` overrides.
