import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_AGENTS, createAtm, type AgentId, type Atm, type AtmErrorJson, type ToolKind, type WriteOptions } from '@atm/core';
import { parseArgs, splitCommand, UsageError, type FlagSpec, type ParsedArgs } from './args.js';
import { colors, renderDoctor, renderList, renderProjects, renderSearch, renderSync, renderWrite, useColor, type Colors } from './output.js';
import { runUi } from './ui.js';

export interface Io {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface Ctx {
  args: ParsedArgs;
  json: boolean;
  /** --cwd or process cwd, absolute */
  cwd: string;
  atm: Atm;
  out: Colors;
  io: Io;
  print(lines: string | string[]): void;
}

interface Command {
  name: string;
  usage: string;
  summary: string;
  flags: FlagSpec;
  /** [min, max] positionals (max = Infinity allowed) */
  args: [number, number];
  run(ctx: Ctx): Promise<number>;
}

const COMMON: FlagSpec = { json: 'bool', cwd: 'string', help: 'bool' };
const WRITE: FlagSpec = { 'dry-run': 'bool' };

// ───────────────────────────── helpers ─────────────────────────────

/** Walk up from `start` to the nearest dir with `.agents/tools.json`; fall back to `start`. */
function findProjectDir(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agents', 'tools.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function writeOpts(ctx: Ctx, extra: Array<'adopt' | 'force'> = []): WriteOptions {
  const o: WriteOptions = {};
  if (ctx.args.flags['dry-run']) o.dryRun = true;
  for (const k of extra) if (ctx.args.flags[k]) o[k] = true;
  return o;
}

function str(ctx: Ctx, key: string): string | undefined {
  const v = ctx.args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

function emit(ctx: Ctx, data: unknown, text: () => string[]): void {
  if (ctx.json) ctx.io.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else ctx.print(text());
}

function parseAgents(raw: string, command: string): AgentId[] {
  const agents = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of agents) {
    if (!(ALL_AGENTS as readonly string[]).includes(a)) throw new UsageError(`unknown agent "${a}" (expected ${ALL_AGENTS.join(', ')})`, command);
  }
  if (!agents.length) throw new UsageError('--agents needs at least one agent', command);
  return agents as AgentId[];
}

export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ───────────────────────────── commands ─────────────────────────────

const COMMANDS: Command[] = [
  {
    name: 'init',
    usage: 'atm init [--force] [--dry-run]',
    summary: 'create .agents/tools.json in this project',
    flags: { ...WRITE, force: 'bool' },
    args: [0, 0],
    async run(ctx) {
      const r = await ctx.atm.init(ctx.cwd, writeOpts(ctx, ['force']));
      emit(ctx, r, () => renderWrite(`initialized ${path.basename(ctx.cwd)}`, r, ctx.out));
      return 0;
    },
  },
  {
    name: 'add skill',
    usage: 'atm add skill <owner/repo> <name> [--rev r] [--dry-run] [--adopt] [--force]',
    summary: 'link a Skill from a shared repo',
    flags: { ...WRITE, rev: 'string', adopt: 'bool', force: 'bool' },
    args: [2, 2],
    async run(ctx) {
      const [repo, name] = ctx.args.positionals as [string, string];
      const rev = str(ctx, 'rev');
      const r = await ctx.atm.add(findProjectDir(ctx.cwd), { kind: 'skill', repo, name, ...(rev ? { rev } : {}) }, writeOpts(ctx, ['adopt', 'force']));
      emit(ctx, r, () => renderWrite(`skill ${name}`, r, ctx.out));
      return 0;
    },
  },
  {
    name: 'add mcp',
    usage: 'atm add mcp <name> [--agents claude-code,cursor,codex] [--dry-run] [--adopt]',
    summary: 'add an MCP server from the registry or .agents/mcp/',
    flags: { ...WRITE, agents: 'string', adopt: 'bool', force: 'bool' },
    args: [1, 1],
    async run(ctx) {
      const [name] = ctx.args.positionals as [string];
      const raw = str(ctx, 'agents');
      const agents = raw === undefined ? undefined : parseAgents(raw, 'add mcp');
      const r = await ctx.atm.add(findProjectDir(ctx.cwd), { kind: 'mcp', name, ...(agents ? { agents } : {}) }, writeOpts(ctx, ['adopt', 'force']));
      emit(ctx, r, () => [...renderWrite(`mcp ${name}`, r, ctx.out), ...(r.applied && r.files.length ? [ctx.out.gray('  restart the agent session to load the MCP server')] : [])]);
      return 0;
    },
  },
  {
    name: 'add plugin',
    usage: 'atm add plugin <plugin@marketplace> [--dry-run] [--adopt]',
    summary: 'enable an installed Claude Code plugin for this project',
    flags: { ...WRITE, adopt: 'bool', force: 'bool' },
    args: [1, 1],
    async run(ctx) {
      const [name] = ctx.args.positionals as [string];
      const r = await ctx.atm.add(findProjectDir(ctx.cwd), { kind: 'plugin', name }, writeOpts(ctx, ['adopt', 'force']));
      emit(ctx, r, () => [...renderWrite(`plugin ${name}`, r, ctx.out), ...(r.applied && r.files.length ? [ctx.out.gray('  restart the agent session to load the plugin')] : [])]);
      return 0;
    },
  },
  {
    name: 'remove',
    usage: 'atm remove <name> [--kind skill|mcp|plugin] [--dry-run]',
    summary: 'remove a tool from this project',
    flags: { ...WRITE, kind: 'string' },
    args: [1, 1],
    async run(ctx) {
      const [name] = ctx.args.positionals as [string];
      const kind = str(ctx, 'kind');
      if (kind !== undefined && !['skill', 'mcp', 'plugin'].includes(kind)) throw new UsageError(`--kind must be skill, mcp or plugin`, 'remove');
      const r = await ctx.atm.remove(findProjectDir(ctx.cwd), name, { ...writeOpts(ctx), ...(kind ? { kind: kind as ToolKind } : {}) });
      emit(ctx, r, () => renderWrite(`removed ${name}`, r, ctx.out));
      return 0;
    },
  },
  {
    name: 'install',
    usage: 'atm install [--strict] [--dry-run] [--adopt] [--force]',
    summary: 'restore every tool from the manifest (idempotent)',
    flags: { ...WRITE, strict: 'bool', adopt: 'bool', force: 'bool' },
    args: [0, 0],
    async run(ctx) {
      const dir = findProjectDir(ctx.cwd);
      const r = await ctx.atm.install(dir, { ...writeOpts(ctx, ['adopt', 'force']), ...(ctx.args.flags.strict ? { strict: true } : {}) });
      emit(ctx, r, () => renderWrite(`installed ${path.basename(dir)}`, r, ctx.out));
      return 0;
    },
  },
  {
    name: 'sync',
    usage: 'atm sync [repo...] [--dry-run]',
    summary: 'git pull --ff-only the shared repos and refresh locks',
    flags: { ...WRITE },
    args: [0, Infinity],
    async run(ctx) {
      const repos = ctx.args.positionals;
      const r = await ctx.atm.sync(repos.length ? repos : undefined, writeOpts(ctx));
      emit(ctx, r, () => renderSync(r, ctx.out));
      return r.repos.some((row) => row.status === 'failed') ? 1 : 0;
    },
  },
  {
    name: 'list',
    usage: 'atm list',
    summary: "show this project's tools and context usage",
    flags: {},
    args: [0, 0],
    async run(ctx) {
      const d = await ctx.atm.list(findProjectDir(ctx.cwd));
      emit(ctx, d, () => renderList(d, ctx.out));
      return 0;
    },
  },
  {
    name: 'doctor',
    usage: 'atm doctor [--measure] [--all]',
    summary: 'check links, secrets, shadowing and context usage',
    flags: { measure: 'bool', all: 'bool' },
    args: [0, 0],
    async run(ctx) {
      const all = Boolean(ctx.args.flags.all);
      const r = await ctx.atm.doctor(all ? 'all' : findProjectDir(ctx.cwd), ctx.args.flags.measure ? { measure: true } : {});
      emit(ctx, r, () => renderDoctor(r, ctx.out, all));
      return r.counts.error > 0 ? 1 : 0;
    },
  },
  {
    name: 'pin',
    usage: 'atm pin <skill> <rev> [--dry-run]',
    summary: 'point a Skill at an isolated worktree of <rev>',
    flags: { ...WRITE },
    args: [2, 2],
    async run(ctx) {
      const [skill, rev] = ctx.args.positionals as [string, string];
      const r = await ctx.atm.pin(findProjectDir(ctx.cwd), skill, rev, writeOpts(ctx));
      emit(ctx, r, () => renderWrite(`pinned ${skill} @ ${rev}`, r, ctx.out));
      return 0;
    },
  },
  {
    name: 'search',
    usage: 'atm search <query>',
    summary: 'search Skills, MCP definitions and plugins in the library',
    flags: {},
    args: [1, Infinity],
    async run(ctx) {
      const query = ctx.args.positionals.join(' ');
      const r = await ctx.atm.search(query);
      emit(ctx, r, () => renderSearch(r, query, ctx.out));
      return 0;
    },
  },
  {
    name: 'projects',
    usage: 'atm projects [--add <dir>] [--remove <idOrDir>]',
    summary: 'list, register or unregister projects',
    flags: { add: 'string', remove: 'string' },
    args: [0, 0],
    async run(ctx) {
      const add = str(ctx, 'add');
      const remove = str(ctx, 'remove');
      if (add && remove) throw new UsageError('use either --add or --remove', 'projects');
      if (add) {
        const p = await ctx.atm.registerProject(path.resolve(ctx.cwd, add));
        emit(ctx, p, () => [`${ctx.out.green('✔')} registered ${ctx.out.bold(p.name)} ${ctx.out.gray(p.path)}`]);
        return 0;
      }
      if (remove) {
        const target = /^[0-9a-f]{12}$/.test(remove) || remove.startsWith('~') ? remove : path.resolve(ctx.cwd, remove);
        await ctx.atm.unregisterProject(target);
        emit(ctx, { ok: true }, () => [`${ctx.out.green('✔')} unregistered ${remove}`]);
        return 0;
      }
      const list = await ctx.atm.projects();
      emit(ctx, list, () => renderProjects(list, ctx.out));
      return 0;
    },
  },
  {
    name: 'ui',
    usage: 'atm ui [--port N] [--no-open]',
    summary: 'open the local web UI',
    flags: { port: 'string', 'no-open': 'bool' },
    args: [0, 0],
    async run(ctx) {
      const raw = str(ctx, 'port');
      let port: number | undefined;
      if (raw !== undefined) {
        port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`invalid --port ${raw}`, 'ui');
      }
      const dir = findProjectDir(ctx.cwd);
      let projectId: string | undefined;
      if (fs.existsSync(path.join(dir, '.agents', 'tools.json')) || (await ctx.atm.config()).projects.includes(dir)) projectId = ctx.atm.projectId(dir);
      return runUi({
        env: ctx.io.env,
        ...(port !== undefined ? { port } : {}),
        open: !ctx.args.flags['no-open'],
        ...(projectId ? { projectId } : {}),
        json: ctx.json,
        print: (lines) => ctx.print(lines),
        stdout: ctx.io.stdout,
        out: ctx.out,
      });
    },
  },
];

// ───────────────────────────── help ─────────────────────────────

function globalUsage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `atm ${version()} — manage per-project Skills, MCP servers and plugins`,
    '',
    'Usage: atm <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    `  ${'help'.padEnd(width)}  show help for a command`,
    '',
    'Global options:',
    '  --json        print one JSON document to stdout',
    '  --cwd <dir>   run against another project directory',
    '  -h, --help    show help',
    '  --version     print the version',
    '',
  ].join('\n');
}

function commandUsage(c: Command): string {
  return [`Usage: ${c.usage}`, '', `  ${c.summary}`, '', '  Also: --json, --cwd <dir>, -h', ''].join('\n');
}

function lookup(name: string, sub?: string): Command | undefined {
  if (name === 'add') return sub ? COMMANDS.find((c) => c.name === `add ${sub}`) : undefined;
  return COMMANDS.find((c) => c.name === name);
}

function usageFor(command?: string): string {
  if (command === 'add') return ['Usage:', ...COMMANDS.filter((c) => c.name.startsWith('add ')).map((c) => `  ${c.usage}`), ''].join('\n');
  const c = command ? COMMANDS.find((x) => x.name === command) : undefined;
  return c ? commandUsage(c) : globalUsage();
}

// ───────────────────────────── entry ─────────────────────────────

function isAtmErrorLike(e: unknown): e is { code: string; message: string; nextCommand?: string; candidates?: string[]; toJSON(): AtmErrorJson } {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { toJSON?: unknown }).toJSON === 'function';
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const errColors = colors(useColor(io.stderr, io.env));
  const usageError = (e: UsageError): number => {
    io.stderr.write(`${errColors.red('✖')} ${e.message}\n\n${usageFor(e.command)}`);
    return 2;
  };

  const { command: name, rest } = splitCommand(argv, ['cwd']);
  const json = rest.includes('--json');

  if (!name) {
    if (rest.includes('--version') || rest.includes('-v')) {
      io.stdout.write(json ? JSON.stringify({ version: version() }) + '\n' : version() + '\n');
      return 0;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      io.stdout.write(globalUsage());
      return 0;
    }
    return usageError(new UsageError('missing command'));
  }

  if (name === 'help') {
    const [first, second] = rest.filter((t) => !t.startsWith('-'));
    io.stdout.write(first ? usageFor(lookup(first, second)?.name ?? (first === 'add' ? 'add' : first)) : globalUsage());
    return 0;
  }

  let cmdArgv = rest;
  let cmd: Command | undefined;
  if (name === 'add') {
    const sub = splitCommand(rest, ['cwd', 'rev', 'agents']);
    if (!sub.command) {
      if (rest.includes('--help') || rest.includes('-h')) {
        io.stdout.write(usageFor('add'));
        return 0;
      }
      return usageError(new UsageError('missing tool kind: skill, mcp or plugin', 'add'));
    }
    cmd = lookup('add', sub.command);
    if (!cmd) return usageError(new UsageError(`unknown tool kind "${sub.command}" (expected skill, mcp or plugin)`, 'add'));
    cmdArgv = sub.rest;
  } else {
    cmd = lookup(name);
    if (!cmd) return usageError(new UsageError(`unknown command "${name}"`));
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(cmdArgv, { ...COMMON, ...cmd.flags }, cmd.name);
    if (args.flags.help) {
      io.stdout.write(commandUsage(cmd));
      return 0;
    }
    const [min, max] = cmd.args;
    if (args.positionals.length < min) throw new UsageError(`missing argument`, cmd.name);
    if (args.positionals.length > max) throw new UsageError(`unexpected argument "${args.positionals[max]}"`, cmd.name);
  } catch (e) {
    if (e instanceof UsageError) return usageError(e);
    throw e;
  }

  const cwdFlag = typeof args.flags.cwd === 'string' ? args.flags.cwd : undefined;
  const cwd = path.resolve(io.cwd, cwdFlag ?? '.');
  const out = colors(!json && useColor(io.stdout, io.env));
  const ctx: Ctx = {
    args,
    json,
    cwd,
    atm: createAtm({ env: io.env }),
    out,
    io,
    print: (lines) => {
      const arr = typeof lines === 'string' ? [lines] : lines;
      if (arr.length) io.stdout.write(arr.join('\n') + '\n');
    },
  };

  try {
    return await cmd.run(ctx);
  } catch (e) {
    if (e instanceof UsageError) return usageError(e);
    const body: AtmErrorJson = isAtmErrorLike(e)
      ? e.toJSON()
      : // Non-AtmError failures have no code in the contract; report them with a synthetic one.
        { error: { code: 'INTERNAL' as AtmErrorJson['error']['code'], message: e instanceof Error ? e.message : String(e) } };
    if (json) io.stdout.write(JSON.stringify(body, null, 2) + '\n');
    else {
      const k = errColors;
      const lines = [`${k.red('✖')} ${k.red(body.error.message)}`];
      if (body.error.candidates?.length) lines.push(k.gray(`  candidates: ${body.error.candidates.join(', ')}`));
      if (body.error.nextCommand) lines.push(k.red(`→ ${body.error.nextCommand}`));
      if (!isAtmErrorLike(e) && e instanceof Error && io.env.ATM_DEBUG && e.stack) lines.push(k.gray(e.stack));
      io.stderr.write(lines.join('\n') + '\n');
    }
    return 1;
  }
}
