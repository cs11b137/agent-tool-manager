import fs from 'node:fs/promises';
import path from 'node:path';
import type { CreateSharedToolInput, GlobalConfig, SharedRepositoryInput, SharedRepositoryStatus } from '../types.js';
import type { Ctx } from '../context.js';
import { initSharedDirectory, loadConfig } from '../config.js';
import { AtmError } from '../errors.js';
import { atomicWrite } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { readText } from '../fs/walk.js';
import { git, runGit } from '../git.js';
import { isToolName } from '../manifest.js';
import { validateMcpDef } from '../mcp/registry.js';

export const SHARED_REPO = 'atm:shared';
export const SHARED_MARKETPLACE = 'atm-shared';
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const inside = (root: string, dir: string) => {
  const rel = path.relative(root, dir);
  return !!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
};
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export async function initSharedRepository(ctx: Ctx, input: SharedRepositoryInput): Promise<GlobalConfig> {
  if (input.defaultAgents !== undefined && (!Array.isArray(input.defaultAgents) || !input.defaultAgents.length || input.defaultAgents.some((agent) => !['claude-code', 'cursor', 'codex'].includes(agent)))) {
    throw new AtmError('INVALID_MANIFEST', '请选择有效的默认 Agent');
  }
  return initSharedDirectory(ctx, input, async (root) => {
    const created: string[] = [];
    let createdGit = false;
    const rollback = async () => {
      for (const file of created.reverse()) await fs.unlink(file);
      if (createdGit) await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
    };
    try {
      const dotGit = await fs.lstat(path.join(root, '.git')).catch((e) => { if (missing(e)) return null; throw e; });
      if (dotGit && !(await git.isRepoRoot(root))) throw new AtmError('CONFLICT', '共享目录的 .git 无效，请选择其他目录');
      if (!dotGit) {
        // Own this directory before invoking Git, so cleanup cannot remove another repository.
        await fs.mkdir(path.join(root, '.git'));
        createdGit = true;
        await runGit(['init', '-b', 'main', '--', root], { signal: ctx.signal });
      }
      const defaults: Record<string, string> = {
        'README.md': '# Agent tools\n\nShared Skills, MCP definitions and Claude Code plugins.\n\nCreate tools in the manager, add projects, then associate tools with projects.\n',
        '.gitignore': '.DS_Store\n.env\n.env.*\n!.env.example\n.worktrees/\nnode_modules/\n',
      };
      for (const [name, content] of Object.entries(defaults)) {
        const file = path.join(root, name);
        try { await fs.writeFile(file, content, { flag: 'wx' }); created.push(file); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      return rollback;
    } catch (e) { await rollback(); throw e; }
  }, input.defaultAgents);
}

function scopes(cfg: GlobalConfig): string[] {
  return ['README.md', '.gitignore', 'skills', 'plugins', '.claude-plugin',
    ...(inside(cfg.root, cfg.mcpRegistry) ? [path.relative(cfg.root, cfg.mcpRegistry)] : [])];
}
async function changes(ctx: Ctx, cfg: GlobalConfig): Promise<string[]> {
  // Git's NUL output preserves spaces/newlines in file names. Use no-renames so both paths are explicit.
  const raw = await runGit(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...scopes(cfg)], { cwd: cfg.root, signal: ctx.signal });
  return raw.split('\0').filter(Boolean).map((s) => s.slice(3));
}
export async function sharedRepository(ctx: Ctx): Promise<SharedRepositoryStatus> {
  const cfg = await loadConfig(ctx);
  const initialized = cfg.sharedRepository === true && await git.isRepoRoot(cfg.root, ctx.signal);
  return {
    initialized, root: cfg.root,
    remote: initialized ? await git.remoteUrl(cfg.root, ctx.signal) ?? '' : '',
    branch: initialized ? await git.branch(cfg.root, ctx.signal) ?? '' : '',
    head: initialized ? await git.tryHead(cfg.root, ctx.signal) ?? '' : '',
    changes: initialized ? await changes(ctx, cfg) : [],
    ahead: initialized ? await git.ahead(cfg.root, ctx.signal) : 0,
    registryIncluded: inside(cfg.root, cfg.mcpRegistry),
  };
}
async function requireRepository(ctx: Ctx): Promise<GlobalConfig> {
  const cfg = await loadConfig(ctx);
  if (!cfg.sharedRepository || !(await git.isRepoRoot(cfg.root, ctx.signal))) throw new AtmError('NOT_INITIALIZED', '请先创建共享仓库');
  return cfg;
}
async function mutate<T>(ctx: Ctx, fn: (cfg: GlobalConfig) => Promise<T>): Promise<T> {
  return withLock(path.join(ctx.configDir, '.lock'), async () => {
    const result = await fn(await requireRepository(ctx));
    ctx.emit({ type: 'library.changed' });
    return result;
  });
}
export async function setSharedRemote(ctx: Ctx, remote: string): Promise<SharedRepositoryStatus> {
  const clean = typeof remote === 'string' ? remote.trim() : '';
  if (!clean || /[\r\n\0]/.test(clean) || (!path.isAbsolute(clean) && /\s/.test(clean)) || !(/^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(clean) || path.isAbsolute(clean))) {
    throw new AtmError('INVALID_MANIFEST', '请输入 HTTPS、SSH 或本地绝对路径的 Git 远程地址');
  }
  if (/^(https|ssh):\/\//.test(clean)) {
    let url: URL;
    try { url = new URL(clean); } catch { throw new AtmError('INVALID_MANIFEST', 'Git 远程地址格式无效'); }
    if (!url.hostname || url.pathname === '/') throw new AtmError('INVALID_MANIFEST', '请填写完整 Git 仓库地址');
    if (url.password || (url.protocol === 'https:' && url.username)) throw new AtmError('INVALID_MANIFEST', '远程地址不能包含密码或令牌，请使用 Git 凭据管理器');
  }
  await mutate(ctx, async (cfg) => {
    const exists = await git.remoteUrl(cfg.root);
    await runGit(['remote', exists === null ? 'add' : 'set-url', 'origin', clean], { cwd: cfg.root, signal: ctx.signal });
  });
  return sharedRepository(ctx);
}
export async function commitSharedRepository(ctx: Ctx, message: string): Promise<SharedRepositoryStatus> {
  if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw new AtmError('INVALID_MANIFEST', '请输入提交说明');
  await mutate(ctx, async (cfg) => {
    const files = await changes(ctx, cfg);
    if (!files.length) throw new AtmError('CONFLICT', '没有可提交的工具改动');
    // Commit only the reviewed managed files; unrelated staged changes remain staged.
    await runGit(['--literal-pathspecs', 'add', '-A', '--', ...files], { cwd: cfg.root, signal: ctx.signal });
    await runGit(['--literal-pathspecs', 'commit', '--only', '-m', message.trim(), '--', ...files], { cwd: cfg.root, signal: ctx.signal });
  });
  return sharedRepository(ctx);
}
export async function pushSharedRepository(ctx: Ctx): Promise<SharedRepositoryStatus> {
  await mutate(ctx, async (cfg) => {
    if (!(await git.remoteUrl(cfg.root))) throw new AtmError('NOT_FOUND', '请先配置远程仓库地址');
    if (!(await git.tryHead(cfg.root))) throw new AtmError('CONFLICT', '请先提交工具改动');
    const branch = await git.branch(cfg.root);
    if (!branch) throw new AtmError('CONFLICT', '当前处于 detached HEAD，请先切换到分支');
    await runGit(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { cwd: cfg.root, signal: ctx.signal ?? AbortSignal.timeout(120_000) });
  });
  return sharedRepository(ctx);
}

/** Reject symlink parents rather than writing outside the selected repository. */
async function ensureRealDir(dir: string, root: string, created: string[]): Promise<void> {
  if (dir === root) return;
  await ensureRealDir(path.dirname(dir), root, created);
  try { await fs.mkdir(dir); created.push(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!(await fs.lstat(dir)).isDirectory()) throw new AtmError('CONFLICT', `目录被文件或软链占用：${dir}`);
  }
}
export async function createSharedTool(ctx: Ctx, input: CreateSharedToolInput): Promise<{ path: string }> {
  if (!input || !['skill', 'mcp', 'plugin'].includes(input.kind)) throw new AtmError('INVALID_MANIFEST', '工具类型必须为 Skill、MCP 或插件');
  const def = input.kind === 'mcp' ? validateMcpDef(input.def) : undefined;
  const name = def?.name ?? ('name' in input ? input.name : '');
  if (typeof name !== 'string' || !isToolName(name)) throw new AtmError('INVALID_MANIFEST', '工具名称只能包含字母、数字、连字符和下划线');
  if (input.kind !== 'mcp' && (typeof input.description !== 'string' || !input.description.trim() || typeof input.content !== 'string' || !input.content.trim())) {
    throw new AtmError('INVALID_MANIFEST', '请填写描述和工具内容');
  }
  return mutate(ctx, async (cfg) => {
    const dirs: string[] = [], files: string[] = [];
    const writeNew = async (file: string, content: string, root = cfg.root) => {
      await ensureRealDir(path.dirname(file), root, dirs);
      try { await fs.writeFile(file, content, { flag: 'wx' }); files.push(file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AtmError('ALREADY_EXISTS', `工具已存在：${name}`); throw e; }
    };
    try {
      if (input.kind === 'mcp') {
        const file = path.join(cfg.mcpRegistry, `${name}.json`);
        await writeNew(file, json(def), cfg.mcpRegistry);
        return { path: file };
      }
      const category = path.join(cfg.root, input.kind === 'skill' ? 'skills' : 'plugins');
      if (await git.isRepoRoot(category)) throw new AtmError('CONFLICT', `工具目录已被独立 Git 仓库占用：${category}`);
      const md = `---\nname: ${name}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n\n${input.content.trim()}\n`;
      if (input.kind === 'skill') {
        const file = path.join(cfg.root, 'skills', name, 'SKILL.md');
        await writeNew(file, md);
        return { path: file };
      }
      const catalogFile = path.join(cfg.root, '.claude-plugin', 'marketplace.json');
      const before = await readText(catalogFile);
      const catalog: { name: string; owner?: { name: string }; plugins: Array<{ name: string; source: string }> } = before ? JSON.parse(before) : { name: SHARED_MARKETPLACE, owner: { name: 'Agent Tool Manager' }, plugins: [] };
      if (catalog.name !== SHARED_MARKETPLACE || !Array.isArray(catalog.plugins)) throw new AtmError('CONFLICT', '此目录已有其他插件 marketplace，请选择其他共享仓库');
      if (catalog.plugins.some((p) => p.name === name)) throw new AtmError('ALREADY_EXISTS', `插件已存在：${name}`);
      const base = path.join(cfg.root, 'plugins', name);
      await writeNew(path.join(base, '.claude-plugin', 'plugin.json'), json({ name, description: input.description.trim(), version: '0.1.0' }));
      await writeNew(path.join(base, 'skills', name, 'SKILL.md'), md);
      await ensureRealDir(path.dirname(catalogFile), cfg.root, dirs);
      const st = await fs.lstat(catalogFile).catch((e) => { if (missing(e)) return null; throw e; });
      if (st && !st.isFile()) throw new AtmError('CONFLICT', 'marketplace.json 必须是普通文件');
      catalog.plugins.push({ name, source: `./plugins/${name}` });
      await atomicWrite(catalogFile, json(catalog));
      return { path: base };
    } catch (e) {
      for (const file of files.reverse()) await fs.unlink(file);
      for (const dir of dirs.reverse()) await fs.rmdir(dir).catch(() => undefined);
      throw e;
    }
  });
}
