---
name: atm-dev
description: atm monorepo 的开发工作流与命令速查。改代码、跑测试、typecheck、启动 server/ui/desktop、写 e2e 前使用；含「包边界契约」red flags（core 保持纯 Node、types.ts 纯类型、测试不碰真实 ~）。
---

# atm-dev

按包定位工作目录，命令一律在仓库根执行（`pnpm --filter <pkg>` 会转发到对应包）。

## 常用命令

| 目标 | 命令 |
| --- | --- |
| 全部构建 | `pnpm build` |
| 全部测试 | `pnpm test` |
| 全部类型检查 | `pnpm typecheck` |
| 单包测试 | `pnpm --filter @atm/core test`（cli 用 `--filter atm`） |
| 单个测试文件 | `pnpm --filter @atm/core test -- test/ops.test.ts` |
| 断言过滤 | 再追加 `-t "<用例名片段>"` |
| watch 模式 | `pnpm --filter @atm/core test:watch` |
| UI 开发（连真实 server） | `pnpm --filter @atm/ui dev`（自动监督后端并热重载） |
| UI 开发（内存 mock） | `pnpm --filter @atm/ui dev:mock` |
| UI e2e | `pnpm --filter @atm/ui e2e`；真实后端 `e2e:real` |
| 桌面 | `pnpm desktop:dev` / `pnpm desktop:build` |
| 桌面 Rust 检查 | `pnpm --filter @atm/desktop check:rust` |

注意：`@atm/ui` 的 `test` 除了 vitest 还会跑 `node --test scripts/*.test.mjs`；`@atm/desktop` 没有 TS，typecheck 是 `node --check`，测试在 `test/*.test.mjs`。

## 包边界契约（docs/implementation-contract.md）

1. `packages/core` 必须保持纯 Node：运行时依赖仅 `smol-toml`、`yauzl`，不得引入 hono/commander/react 等框架，也不得 import 其他 @atm 包。
2. `packages/core/src/types.ts` 是四个包共享的唯一类型来源：不 import 任何 Node 模块；已有字段不改，只能追加；浏览器端以 `import type` 引用。小常量（如 `ALL_AGENTS`）允许。
3. 测试永远用临时目录 + 覆盖的 `home` / `env`（见 `packages/core/test/helpers.ts`），不碰真实 `~`。测试代码里出现 `os.homedir()` 通常是坏味道。
4. `AtmError` 每条抛错都带 `nextCommand`；server 错误映射：`LOCKED`/`CONFLICT`→409，`NOT_FOUND`→404，`INVALID_*`→400。
5. 写操作一律「先 plan 出 `FileChange[]` 再 apply」，dryRun 只返回 plan；apply 用临时文件 + rename 并持有 `.agents/.lock`。
6. git 调用集中在 `packages/core/src/git.ts`，便于测试 mock。

## 快速验证

改 core / server / cli / ui 任意一处后：`pnpm typecheck` + 相关包的定向测试。仓库内置 `atm_check`（pi 扩展工具）可在几秒内静态核对第 1–3 条红线，改完 core 相关文件后跑一次；用 `atm_sandbox` 可以在一次性临时 HOME 里试运行 `atm` CLI（自动用 `packages/cli/dist/bin.js`），适合验证 init/add/doctor 的真实落盘行为。
