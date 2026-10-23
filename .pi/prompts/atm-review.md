---
description: 按 docs/implementation-contract.md 审查当前未提交改动
argument-hint: "[关注点，如 core/server/ui]"
---
审查本仓库当前未提交的改动（含未跟踪文件），严格对照 `docs/implementation-contract.md`。

步骤：
1. `git status --short` 与 `git diff`（必要时 `git diff --staged`）看本次改动范围。
2. 用户额外关注点（可能为空）：$1 —— 有则优先覆盖第 4 步对应包的规则。
2. 调用 `atm_check` 工具跑红线静态检查（core 依赖白名单、types.ts 纯类型、core 源码禁用模块、测试不碰真实 ~）。
3. `pnpm typecheck`；若改动集中在一个包，再跑该包的定向测试（命令见 atm-dev skill）。
4. 逐条核对与改动相关的契约规则：
   - core：纯 Node、git 调用只在 git.ts、写操作先 plan 后 apply、错误带 nextCommand
   - server：错误码映射（LOCKED/CONFLICT→409、NOT_FOUND→404、INVALID_*→400）、SSE 事件不泄漏密钥
   - cli：退出码 0/1/2、`--json` 输出 AtmErrorJson、文本输出短且不引额外依赖
   - ui：类型从 `@atm/core/types` `import type` 引用；文案走 locales，不硬编码
   - types.ts：已有字段不改，只能追加
5. 输出结论：发现的问题按「阻塞 / 建议 nodig / 可忽略」分级列出，每条给文件:行号和修法；没有问题就明说通过。
