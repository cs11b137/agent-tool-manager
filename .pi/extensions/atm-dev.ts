/**
 * atm-dev — 本仓库（agent-tool-manager）专用 pi 开发工具
 *
 * Tools:
 *   atm_check    秒级静态核对仓库契约红线（docs/implementation-contract.md）：
 *                core 依赖白名单、types.ts 纯类型、源码禁用模块、测试不碰真实 ~。
 *   atm_sandbox  在一次性临时 HOME 里试运行本地构建的 atm CLI，不碰真实 ~；
 *                可选 seed：生成 ~/.agent-tools（work repo + bare remote + demo skill）。
 *
 * Hook:
 *   tool_result  编辑/写入 packages/core/src/types.ts 后自动追加契约检查结论。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type JsonValue } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ExtensionAPI,
  type ToolResultEvent,
  type ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';

// ───────────────────────────── 基础设施 ─────────────────────────────

let cachedRoot: string | undefined;

/** 从 cwd 向上找仓库根（含 pnpm-workspace.yaml 且有 packages/cli）。 */
function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) && existsSync(path.join(dir, 'packages', 'cli'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：扩展文件位于 <repo>/.pi/extensions/，据此定位仓库根
  let here = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(here, 'pnpm-workspace.yaml'))) {
      cachedRoot = here;
      return here;
    }
    const parent = path.dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return (cachedRoot = process.cwd());
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n !== '.DS_Store');
  } catch {
    return [];
  }
}

// ───────────────────────────── 契约检查 ─────────────────────────────

interface Finding {
  level: 'error' | 'warn';
  file: string;
  line?: number;
  message: string;
}

const CORE_DEPS_ALLOW = new Set(['smol-toml', 'yauzl']);

const CORE_BANNED_IMPORTS: Array<{ re: RegExp; why: string }> = [
  { re: /^@atm\/(server|cli|ui|desktop)$/, why: 'core 不允许依赖其他 @atm 包' },
  { re: /^(hono|@hono\/.*)$/, why: 'core 禁止 HTTP 框架' },
  { re: /^(commander|express|react|fastify|koa)$/, why: 'core 禁止 CLI/HTTP/UI 框架依赖' },
];

/** `import type {…} from 'x'` / `export type {…} from 'x'` 是纯类型引用，不算运行时依赖。 */
const isTypeOnlyLine = (line: string) => /^\s*(import|export)\s+type[\s{]/.test(line);

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function scanCoreSource(findings: Finding[]): void {
  const srcDir = path.join(repoRoot(), 'packages/core', 'src');

  const walk = (dir: string, rel: string): void => {
    for (const name of listDir(dir)) {
      const abs = path.join(dir, name);
      const relFull = rel ? `${rel}/${name}` : name; // 相对 packages/core/src
      const relPath = `packages/core/src/${relFull}`;
      if (isDir(abs)) {
        walk(abs, relFull);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (isTypeOnlyLine(line)) return;
        for (const m of line.matchAll(IMPORT_RE)) {
          const spec = m[1];
          if (spec.startsWith('.') || spec === '') continue;
          if (spec.startsWith('node:')) continue;
          if (CORE_DEPS_ALLOW.has(spec)) continue;
          // node 内置但没用 node: 前缀
          if (/^(fs|path|os|url|crypto|child_process|stream|util|events|assert)$/.test(spec)) {
            findings.push({ level: 'warn', file: relPath, line: i + 1, message: `裸 node 内置导入 '${spec}'，请写 'node:${spec}'` });
            continue;
          }
          const banned = CORE_BANNED_IMPORTS.find((b) => b.re.test(spec));
          findings.push({
            level: 'error',
            file: relPath,
            line: i + 1,
            message: banned ? `'${spec}': ${banned.why}` : `import '${spec}' 不在 core 运行时依赖（smol-toml、yauzl、node 内置）内`,
          });
        }
      });
    }
  };
  walk(srcDir, '');
}

function scanTypesTs(rel: string): Finding[] {
  const abs = path.join(repoRoot(), rel);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  return scanTypesText(text);
}

export function scanTypesText(text: string): Finding[] {
  const out: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (/^\s*import(?!\s+type[\s{])[\w\W]*from\s*['"][^'"]+['"]/.test(line)) {
      out.push({ level: 'error', file: 'packages/core/src/types.ts', line: n, message: 'types.ts 必须保持纯类型：不允许运行时 import（浏览器端用 import type 引用此文件）' });
    }
    if (/^\s*import\s*['"]/.test(line)) {
      out.push({ level: 'error', file: 'packages/core/src/types.ts', line: n, message: 'types.ts 禁止 side-effect 导入' });
    }
    if (/^\s*export\s+(function|class|enum|default)\b/.test(line)) {
      out.push({ level: 'error', file: 'packages/core/src/types.ts', line: n, message: 'types.ts 不允许导出 function/class/enum/default 等运行时实体（const 数据常量允许，如 ALL_AGENTS）' });
    }
    const reExport = /^\s*export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/.exec(line);
    if (reExport && !/^\s*export\s+type\s*\{/.test(line) && !line.includes('export type {')) {
      out.push({ level: 'warn', file: 'packages/core/src/types.ts', line: n, message: "`export { … } from` 会再导出运行时值；面向纯类型请用 `export type { … }`" });
    }
  });
  return out;
}

function scanCoreTestsForHome(findings: Finding[]): void {
  const dir = path.join(repoRoot(), 'packages/core/test');
  for (const name of listDir(dir)) {
    const abs = path.join(dir, name);
    if (isDir(abs) || !name.endsWith('.ts')) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (/os\.homedir\s*\(/.test(line)) {
        findings.push({ level: 'warn', file: `packages/core/test/${name}`, line: i + 1, message: '测试里出现 os.homedir()；fixture 应基于临时目录，通过 createAtm({ home, env }) 覆盖' });
      }
    });
  }
}

async function collectFindings(): Promise<{ findings: Finding[]; skipped: string[] }> {
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const root = repoRoot();

  // 1) core 依赖白名单
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const d of Object.keys(pkg.dependencies ?? {})) {
      if (!CORE_DEPS_ALLOW.has(d)) {
        findings.push({ level: 'error', file: 'packages/core/package.json', message: `运行时依赖 '${d}' 不在白名单（仅 smol-toml、yauzl）` });
      }
    }
  } catch (e) {
    skipped.push(`core package.json 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) types.ts 纯类型
  const typesAbs = path.join(root, 'packages/core/src/types.ts');
  findings.push(...scanTypesTs('packages/core/src/types.ts'));
  if (!existsSync(typesAbs)) skipped.push('types.ts 不存在（可能被移动）');

  // 3) core 源码禁用/未知依赖
  if (existsSync(path.join(root, 'packages/core/src'))) scanCoreSource(findings);
  else skipped.push('packages/core/src 不存在');

  // 4) 测试不碰真实 ~（warn）
  if (existsSync(path.join(root, 'packages/core/test'))) scanCoreTestsForHome(findings);
  else skipped.push('packages/core/test 不存在');

  return { findings, skipped };
}

const fmtFindings = (findings: Finding[]): string =>
  findings.length
    ? findings.map((f) => `${f.level === 'error' ? '✖' : '▲'} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`).join('\n')
    : '（无发现）';

/** 任意值 → JSON 兼容值，满足 structuredContent 的 JsonValue 约束。 */
const toJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

const atmCheck = defineTool({
  name: 'atm_check',
  label: 'ATM 契约检查',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  description:
    '静态核对 agent-tool-manager 仓库的包边界契约（docs/implementation-contract.md）：core 运行时依赖白名单、types.ts 纯类型（无运行时 import/函数导出）、core 源码禁止的框架导入、core 测试是否误用 os.homedir()。只读、秒级。改动 core、types.ts 或 core 依赖后必跑；改动 server/cli/ui 后建议跑。',
  parameters: Type.Object({}),
  outputSchema: Type.Object({
    ok: Type.Boolean(),
    errors: Type.Number(),
    warnings: Type.Number(),
    findings: Type.Array(Type.Object({ level: Type.String(), file: Type.String(), line: Type.Optional(Type.Number()), message: Type.String() })),
    skipped: Type.Array(Type.String()),
  }),
  async execute() {
    const { findings, skipped } = await collectFindings();
    const errors = findings.filter((f) => f.level === 'error');
    const warnings = findings.filter((f) => f.level === 'warn');
    const header = errors.length
      ? `atm 契约检查：${errors.length} error, ${warnings.length} warn — 存在红线问题，必须修复`
      : warnings.length
        ? `atm 契约检查：0 error, ${warnings.length} warn — 无红线问题`
        : 'atm 契约检查：全部通过 ✓';
    const skippedNote = skipped.length ? `\n（已跳过：${skipped.join('；')}）` : '';
    const hint =
      warnings.some((w) => /homedir/.test(w.message))
        ? '\n修复方式：参照 packages/core/test/helpers.ts 用临时目录 fixture，并通过 createAtm({ home, env }) 覆盖。'
        : errors.length
          ? '\n相关规则见 .pi/skills/atm-dev/SKILL.md「包边界契约」。'
          : '';
    return {
      content: [{ type: 'text', text: `${header}\n${fmtFindings([...errors, ...warnings])}${skippedNote}${hint}` }],
      details: { errors: errors.length, warnings: warnings.length, findings: [...errors, ...warnings], skipped },
      structuredContent: toJson({ ok: errors.length === 0, errors: errors.length, warnings: warnings.length, findings, skipped }),
      isError: errors.length > 0,
    };
  },
});

// ───────────────────────────── 工具 2：atm_sandbox ─────────────────────────────

/** 极简 shell 风格分词（支持单双引号与反斜杠转义）。失败（未闭合引号）返回 null。 */
function splitArgs(input: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let mode: 'plain' | 'dq' | 'sq' = 'plain';
  let esc = false;
  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (mode === 'sq') {
      if (ch === "'") mode = 'plain';
      else cur += ch;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (mode === 'dq') {
      if (ch === '"') mode = 'plain';
      else cur += ch;
      continue;
    }
    if (ch === "'") {
      mode = 'sq';
      continue;
    }
    if (ch === '"') {
      mode = 'dq';
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (esc || mode !== 'plain') return null;
  if (cur) out.push(cur);
  return out;
}

interface CmdOutcome {
  cmd: string;
  code: number | null;
  signal: string | null;
  ms: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const CAP = 6000;

function clip(s: string): { text: string; truncated: boolean } {
  if (s.length <= CAP) return { text: s, truncated: false };
  return { text: `…（头部省略 ${s.length - CAP} 字符）\n${s.slice(-CAP)}`, truncated: true };
}

function pickNodeExe(fallback: string): string {
  const probe = spawnSync('node', ['-v'], { timeout: 10_000, stdio: 'ignore', env: process.env });
  return probe.error ? fallback : 'node';
}

function runAtm(nodeExe: string, bin: string, argv: string[], cwd: string, home: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<CmdOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(nodeExe, [bin, ...argv], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout = (stdout + c.toString('utf8')).slice(-CAP * 3);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-CAP * 3);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        cmd: argv.join(' '),
        code: null,
        signal: null,
        ms: Date.now() - started,
        stdout: '',
        stderr: err.code === 'ENOENT' ? 'spawn 失败：找不到 node，请确认环境有 node ≥ 20' : String(err),
        truncated: false,
      });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ cmd: argv.join(' '), code, signal: sig, ms: Date.now() - started, stdout, stderr, truncated: false });
    });
  });
}

const SANDBOX_MARKER = '.atm-sandbox.json';

async function ensureSandbox(homeArg?: string): Promise<{ home: string; project: string; fresh: boolean }> {
  const tmp = path.resolve(tmpdir());
  if (homeArg) {
    const home = path.resolve(homeArg);
    if (home !== tmp && !home.startsWith(tmp + path.sep)) {
      throw new Error(`home 必须位于系统临时目录 ${tmp} 之下，为安全起见拒绝其他路径`);
    }
    if (!existsSync(home)) throw new Error(`复用的 sandbox ${home} 不存在（可能已被系统清理，请新建）`);
    const marker = path.join(home, SANDBOX_MARKER);
    if (!existsSync(marker)) throw new Error('复用的目录不是 atm_sandbox 创建的 sandbox（缺 marker），已拒绝');
    try {
      const project = (JSON.parse(await readFile(marker, 'utf8')) as { project?: string }).project;
      if (project && existsSync(project)) return { home, project, fresh: false };
    } catch {
      /* marker 损坏则退回新建 */
    }
    throw new Error('sandbox marker 损坏，请新建 sandbox（不传 home）');
  }
  const base = await mkdtemp(path.join(tmp, 'atm-sandbox-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  await writeFile(path.join(home, SANDBOX_MARKER), JSON.stringify({ project }, null, 2), 'utf8');
  return { home, project, fresh: true };
}

function seedShared(home: string): string[] {
  // 与 GUI 的共享仓库初始化一致：<root> 本身是 git 仓库；skill 放 <root>/skills/
  const root = path.join(home, '.agent-tools');
  const bare = path.join(home, 'remotes', 'shared.git');
  const ident = ['-c', 'user.email=atm-sandbox@example.com', '-c', 'user.name=atm-sandbox'];
  const git = (args: string[], cwd: string): void => {
    const r = spawnSync('git', [...ident, ...args], { cwd, encoding: 'utf8', env: process.env });
    if (r.status !== 0 && r.status !== null) {
      throw new Error(`git ${args.join(' ')}（cwd=${cwd}）失败：${r.stderr}`);
    }
    if (r.status === null) throw new Error(`git ${args.join(' ')} 无法启动（cwd=${cwd} 可能不存在？）：${r.error?.message ?? 'unknown'}`);
  };
  mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  mkdirSync(path.dirname(bare), { recursive: true });
  writeFileSync(
    path.join(root, 'skills', 'demo-skill', 'SKILL.md'),
    ['---', 'name: demo-skill', 'description: atm_sandbox 生成的演示 Skill，用于验证 add/install/doctor 链接流程。', '---', '', '# demo-skill', '', '占位内容：`atm add skill atm:shared demo-skill` 后应出现在项目 `.agents/skills`。', ''].join('\n'),
    'utf8',
  );
  git(['init', '-q', '-b', 'main'], root);
  const bareInit = spawnSync('git', [...ident, 'init', '--bare', '-q', '-b', 'main', bare], { cwd: home, encoding: 'utf8', env: process.env });
  if (bareInit.status !== 0) throw new Error(`git init --bare 失败：${bareInit.stderr ?? bareInit.error?.message ?? ''}`);
  git(['remote', 'add', 'origin', bare], root);
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'seed demo-skill'], root);
  git(['push', '-q', 'origin', 'main'], root);
  return [
    `已初始化共享仓库 → ${root}（=root 本身建仓；skills/demo-skill 已推送 bare remote ${bare}）`,
    '后续 skill 命令写法：atm add skill atm:shared demo-skill',
  ];
}

function assertSandboxScope(argv: string[], sandboxHome: string, sandboxProject: string): string | null {
  const tmpBase = path.dirname(sandboxHome);
  const inside = (p: string): boolean => {
    const r = path.resolve(p);
    return r === tmpBase || r.startsWith(tmpBase + path.sep);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === 'ui') return 'atm ui 会在本机起 HTTP server 并打开浏览器，sandbox 里禁止使用；';
    let flagVal: string | undefined;
    if (a === '--cwd') flagVal = argv[i + 1];
    else if (a.startsWith('--cwd=')) flagVal = a.slice('--cwd='.length);
    if (flagVal) {
      const resolved = path.resolve(sandboxProject, flagVal);
      if (!inside(resolved) || !inside(sandboxProject)) return `--cwd ${flagVal} 指向 sandbox 之外的路径，拒绝执行（sandbox根：${tmpBase}）`;
    }
  }
  return null;
}

const atmSandbox = defineTool({
  name: 'atm_sandbox',
  label: 'ATM CLI 沙盒',
  description:
    '在一次性临时 HOME 里试运行本地构建的 atm CLI（packages/cli/dist/bin.js），验证 init/add/install/doctor/list 等真实落盘行为，绝不碰真实 ~。每次调用默认创建全新 sandbox；把上次返回的 home 传回可复用同一环境连续操作。可先 seed 共享仓库（root 建仓 + demo-skill，命令写法 atm add skill atm:shared demo-skill）。命令按顺序执行，默认遇非零退出即停止（可用 stopOnFailure=false 继续）。',
  parameters: Type.Object({
    commands: Type.Array(
      Type.String({ description: '一条 atm 命令的参数串，例如 "init"、"list --json"、"add skill atm:shared demo-skill"、"doctor --json"（--cwd 只能指向 sandbox 内路径）' }),
      { description: '按顺序执行的命令列表；失败即停（见 stopOnFailure）。各命令共享同一 cwd（project dir）与 HOME' },
    ),
    seed: Type.Optional(Type.Boolean({ description: '执行前初始化 ~/.agent-tools 共享仓库（root 建仓 + skills/demo-skill + bare remote），供 `atm add skill atm:shared demo-skill` 使用' })),
    stopOnFailure: Type.Optional(Type.Boolean({ description: '默认 true；false 时命令失败也继续执行后续命令' })),
    home: Type.Optional(Type.String({ description: '复用上次返回的 sandbox HOME（必须位于系统临时目录内），实现跨调用的连续操作' })),
    timeout: Type.Optional(Type.Number({ description: '每条命令超时秒数，默认 120，上限 300' })),
  }),
  outputSchema: Type.Object({
    ok: Type.Boolean(),
    home: Type.String(),
    project: Type.String(),
    stopOnFailure: Type.Boolean(),
    results: Type.Array(
      Type.Object({ cmd: Type.String(), code: Type.Optional(Type.Number()), ms: Type.Number(), truncated: Type.Boolean() }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const root = repoRoot();
    const bin = path.join(root, 'packages/cli/dist/bin.js');
    if (!existsSync(bin)) {
      const b = spawnSync('pnpm', ['--filter', 'atm', 'build'], { cwd: root, encoding: 'utf8', timeout: 180_000, env: process.env });
      if (!existsSync(bin)) {
        return {
          content: [
            {
              type: 'text',
              text: `packages/cli/dist 不存在，自动构建（pnpm --filter atm build）也未产出，多半是类型错误。\nstdout 尾部：${(b.stdout as string | undefined)?.slice(-2000) ?? '(空)'}\nstderr 尾部：${(b.stderr as string | undefined)?.slice(-2000) ?? '(空)'}\n请先在仓库根执行 pnpm --filter atm build 修复后再试。`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    }

    let sandbox: { home: string; project: string; fresh: boolean };
    try {
      sandbox = await ensureSandbox(params.home);
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], details: undefined, isError: true };
    }

    const seedLog: string[] = [];
    if (params.seed) {
      try {
        seedLog.push(...seedShared(sandbox.home));
      } catch (e) {
        return { content: [{ type: 'text', text: `seed 失败：${e instanceof Error ? e.message : String(e)}` }], details: undefined, isError: true };
      }
    }

    const stopOnFailure = params.stopOnFailure ?? true;
    const timeoutSec = Math.min(Math.max(params.timeout ?? 120, 1), 300);
    const results: CmdOutcome[] = [];
    let aborted = false;
    for (const raw of params.commands) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const argv = splitArgs(raw);
      if (!argv || !argv.length) {
        results.push({ cmd: raw, code: null, signal: null, ms: 0, stdout: '', stderr: '无法解析：命令串为空或引号未闭合', truncated: false });
        break;
      }
      const scopeMsg = assertSandboxScope(argv, sandbox.home, sandbox.project);
      if (scopeMsg) {
        results.push({ cmd: argv.join(' '), code: null, signal: null, ms: 0, stdout: '', stderr: scopeMsg, truncated: false });
        break;
      }
      const r = await runAtm(pickNodeExe(process.execPath), bin, argv, sandbox.project, sandbox.home, signal, timeoutSec * 1000);
      const so = clip(r.stdout);
      const se = clip(r.stderr);
      r.stdout = so.text;
      r.stderr = se.text;
      r.truncated = so.truncated || se.truncated;
      results.push(r);
      if (stopOnFailure && r.code !== 0) break;
    }

    const lines: string[] = [
      `sandbox ${aborted ? '（已取消）' : ''}${sandbox.fresh ? '新建' : '复用'}：${sandbox.home}`,
      `project dir（命令 cwd）：${sandbox.project}　← 用 read/bash 可直接查看落盘结果；跨包路径用绝对或 sandbox 内相对路径`,
    ];
    if (seedLog.length) lines.push(...seedLog);
    for (const r of results) {
      lines.push(`$ atm ${r.cmd}`);
      lines.push(`  exit ${r.code ?? 'spawn-error'}${r.signal ? ` (${r.signal})` : ''} · ${r.ms}ms${r.truncated ? ' · 输出已截尾' : ''}`);
      if (r.stdout.trim()) lines.push(r.stdout.trimEnd());
      if (r.stderr.trim()) lines.push(`stderr:\n${r.stderr.trimEnd()}`);
    }
    const failed = results.some((r) => r.code !== 0);
    lines.push('');
    lines.push('提示：不要手改 tools.lock.json 与各 Agent 生成配置——sandbox 里也统一走 atm 命令；CONFLICT 类错误按 skill 提示加 --adopt 重试。');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { home: sandbox.home, project: sandbox.project, results },
      structuredContent: toJson({ ok: !failed, home: sandbox.home, project: sandbox.project, stopOnFailure, results: results.map((r) => ({ cmd: r.cmd, code: r.code ?? undefined, ms: r.ms, truncated: r.truncated })) }),
      isError: failed,
    };
  },
});

// ───────────────────────────── 注册 ─────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(atmCheck);
  pi.registerTool(atmSandbox);

  // 编辑 types.ts 后就地给出契约检查结论（error 会把该工具结果标为失败）
  pi.on('tool_result', async (event: ToolResultEvent): Promise<ToolResultEventResult | undefined> => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    const p = (event.input as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string') return undefined;
    let resolved: string;
    try {
      resolved = path.resolve(p);
    } catch {
      return undefined;
    }
    if (path.normalize(resolved) !== path.normalize(path.join(repoRoot(), 'packages/core/src/types.ts'))) return undefined;
    let text: string;
    try {
      text = await readFile(resolved, 'utf8');
    } catch {
      return undefined; // 文件被删/移动等情况不再追问
    }
    const findings = scanTypesText(text);
    if (!findings.length) return undefined;
    const note = `\n\n[atm-dev] types.ts 契约检查:${findings.some((f) => f.level === 'error') ? '存在违反纯类型红线的问题' : '建议'}\n${fmtFindings(findings)}\n（纯类型文件：可用 import type / export type / const 数据常量；不得运行时 import 或导出 function/class）`;
    return {
      content: [...event.content, { type: 'text', text: note }],
      isError: event.isError || findings.some((f) => f.level === 'error'),
    };
  });
}
