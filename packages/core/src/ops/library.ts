import fs from 'node:fs/promises';
import path from 'node:path';
import type { LibraryItem, McpDef, RepoStatus, SearchResult } from '../types.js';
import { compactHome, projectId, type Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { AtmError } from '../errors.js';
import { atomicWrite } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { exists, isDir, listDir } from '../fs/walk.js';
import { git } from '../git.js';
import { mcpRefName, paths } from '../manifest.js';
import { envVarStatus, loadDefs, validateMcpDef } from '../mcp/registry.js';
import { discoverSkills } from '../skills/discover.js';
import { parseRepo, repoSlugFromRemote } from '../skills/repo.js';
import { locateRepoDir } from '../skills/resolver.js';
import { loadShared, type Shared } from './inspect.js';

/** `<root>` 下的顶层目录（跳过 `.worktrees`、隐藏目录与 registry）。 */
async function rootDirs(root: string, registry: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir(root)) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    if (dir === registry || !(await isDir(dir))) continue;
    out.push(dir);
  }
  return out;
}

async function repoSlug(ctx: Ctx, dir: string): Promise<{ slug: string; remote: string }> {
  const remote = (await git.remoteUrl(dir, ctx.signal)) ?? '';
  return { slug: remote ? repoSlugFromRemote(remote) : dir, remote };
}

async function skillUsers(ctx: Ctx, shared: Shared, repoDir: string, name: string): Promise<string[]> {
  const users: string[] = [];
  for (const [id, { manifest }] of shared.manifests) {
    for (const s of manifest.skills) {
      if (s.name === name && (await locateRepoDir(ctx, shared.cfg.root, s.repo)) === repoDir) users.push(id);
    }
  }
  return users;
}

export async function buildLibrary(ctx: Ctx): Promise<LibraryItem[]> {
  const cfg = await loadConfig(ctx);
  const shared = await loadShared(ctx, cfg);
  const items: LibraryItem[] = [];

  for (const dir of await rootDirs(cfg.root, cfg.mcpRegistry)) {
    const skills = await discoverSkills(ctx, dir, path.basename(dir));
    if (!skills.length) continue;
    const { slug } = await repoSlug(ctx, dir);
    const commit = (await git.tryHead(dir, ctx.signal)) ?? '';
    for (const s of skills) {
      const item: LibraryItem = {
        kind: 'skill',
        name: s.name,
        source: slug,
        detail: s.path,
        contextTokens: s.contextTokens,
        usedBy: await skillUsers(ctx, shared, dir, s.name),
        global: shared.globalSkills.has(s.name),
        skill: { repo: slug, repoDir: dir, path: s.path, commit },
      };
      if (s.description) item.description = s.description;
      items.push(item);
    }
  }

  // MCP：registry + 各已注册项目的 .agents/mcp/
  const measured = new Map<string, number>();
  const mcpUsers = new Map<string, string[]>();
  for (const [id, { dir, manifest }] of shared.manifests) {
    const lockText = await fs.readFile(paths.lock(dir), 'utf8').catch(() => null);
    const lock = lockText ? (JSON.parse(lockText) as { mcp?: Record<string, { contextTokens?: number }> }) : null;
    for (const ref of manifest.mcp) {
      const name = mcpRefName(ref);
      mcpUsers.set(name, [...(mcpUsers.get(name) ?? []), id]);
      const t = lock?.mcp?.[name]?.contextTokens;
      if (typeof t === 'number' && !measured.has(name)) measured.set(name, t);
    }
  }
  const pushMcp = (def: McpDef, origin: 'registry' | 'project', usedBy: string[], source: string) => {
    const item: LibraryItem = {
      kind: 'mcp',
      name: def.name,
      source,
      detail: def.transport,
      contextTokens: measured.get(def.name) ?? null,
      usedBy,
      global: false,
      mcp: { transport: def.transport, origin, envVars: envVarStatus(def, ctx.env) },
    };
    if (def.description) item.description = def.description;
    items.push(item);
  };
  for (const { def } of shared.registry.defs.values()) pushMcp(def, 'registry', mcpUsers.get(def.name) ?? [], 'registry');
  for (const [id, { dir }] of shared.manifests) {
    const defs = await loadDefs(path.join(dir, '__none__'), dir);
    for (const { def, origin } of defs.defs.values()) {
      if (origin !== 'project') continue;
      pushMcp(def, 'project', (mcpUsers.get(def.name) ?? []).filter((u) => u === id), 'project');
    }
  }

  // 插件
  for (const [name, inst] of shared.plugins.installed) {
    const contents = await shared.plugins.contents(name);
    const usedBy = [...shared.manifests.entries()].filter(([, v]) => v.manifest.plugins.includes(name)).map(([id]) => id);
    const globallyEnabled = shared.plugins.globallyEnabled.has(name);
    const plugin: NonNullable<LibraryItem['plugin']> = { marketplace: inst.marketplace, installed: true, globallyEnabled };
    if (inst.version) plugin.version = inst.version;
    const item: LibraryItem = {
      kind: 'plugin',
      name,
      source: inst.marketplace ? `@${inst.marketplace}` : 'plugin',
      detail: inst.marketplace,
      contextTokens: contents ? contents.skills.reduce((a, s) => a + s.contextTokens, 0) : null,
      usedBy,
      global: globallyEnabled,
      plugin,
    };
    items.push(item);
  }
  return items;
}

function score(item: LibraryItem, q: string): number {
  const fields = [item.name, item.source, item.skill?.repo ?? '', item.description ?? ''].map((f) => f.toLowerCase());
  const name = fields[0]!;
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (fields.slice(1).some((f) => f.includes(q))) return 40;
  const subseq = (s: string) => {
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length;
  };
  if (subseq(name)) return 20;
  return 0;
}

export async function searchLibrary(ctx: Ctx, query: string): Promise<SearchResult> {
  const q = query.trim().toLowerCase();
  const items = await buildLibrary(ctx);
  if (!q) return { items };
  const scored = items.map((item) => ({ item, s: score(item, q) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.item.name.localeCompare(b.item.name));
  return { items: scored.map((x) => x.item) };
}

async function repoStatus(ctx: Ctx, shared: Shared | null, dir: string): Promise<RepoStatus> {
  const { slug, remote } = await repoSlug(ctx, dir);
  const usedBy: string[] = [];
  if (shared) {
    for (const [id, { manifest }] of shared.manifests) {
      for (const s of manifest.skills) {
        if ((await locateRepoDir(ctx, shared.cfg.root, s.repo)) === dir && !usedBy.includes(id)) usedBy.push(id);
      }
    }
  }
  const status: RepoStatus = {
    repo: slug,
    dir,
    remote,
    head: (await git.tryHead(dir, ctx.signal)) ?? '',
    dirty: await git.isDirty(dir, ctx.signal),
    ahead: await git.ahead(dir, ctx.signal),
    usedBy,
  };
  const branch = await git.branch(dir, ctx.signal);
  if (branch) status.branch = branch;
  return status;
}

export async function listRepos(ctx: Ctx): Promise<RepoStatus[]> {
  const cfg = await loadConfig(ctx);
  const shared = await loadShared(ctx, cfg);
  const out: RepoStatus[] = [];
  const dirs = await rootDirs(cfg.root, '');
  for (const dir of dirs) {
    if (!(await exists(path.join(dir, '.git')))) continue;
    out.push(await repoStatus(ctx, shared, dir));
  }
  return out;
}

export async function cloneRepo(ctx: Ctx, repo: string): Promise<RepoStatus> {
  const cfg = await loadConfig(ctx);
  const spec = parseRepo(repo, ctx.home);
  const dir = path.join(cfg.root, spec.name);
  if (await exists(dir)) {
    throw new AtmError('CONFLICT', `${compactHome(ctx.home, dir)} already exists`, {
      nextCommand: spec.owner ? `git clone ${spec.url} ${compactHome(ctx.home, path.join(cfg.root, `${spec.owner}-${spec.name}`))}` : `rm -rf ${dir}`,
    });
  }
  await fs.mkdir(cfg.root, { recursive: true });
  await git.clone(spec.url, dir, ctx.signal);
  ctx.emit({ type: 'library.changed' });
  ctx.activity({ level: 'info', message: `Cloned ${repo} into ${compactHome(ctx.home, dir)}` });
  return repoStatus(ctx, null, dir);
}

export async function saveMcpDef(
  ctx: Ctx,
  def: McpDef,
  scope: 'registry' | { projectDir: string },
  resolveProject: (idOrDir: string) => Promise<string>,
): Promise<{ path: string }> {
  const valid = validateMcpDef(def);
  const cfg = await loadConfig(ctx);
  const text = JSON.stringify(valid, null, 2) + '\n';
  if (scope === 'registry') {
    const file = path.join(cfg.mcpRegistry, `${valid.name}.json`);
    await atomicWrite(file, text);
    ctx.emit({ type: 'library.changed' });
    ctx.activity({ level: 'info', kind: 'mcp', message: `Saved MCP definition ${valid.name} to the registry` });
    return { path: file };
  }
  const dir = await resolveProject(scope.projectDir);
  const file = path.join(paths.projectMcpDir(dir), `${valid.name}.json`);
  await fs.mkdir(paths.agentsDir(dir), { recursive: true });
  await withLock(paths.writeLock(dir), () => atomicWrite(file, text));
  const pid = projectId(dir);
  ctx.emit({ type: 'library.changed' });
  ctx.emit({ type: 'project.changed', projectId: pid, reason: 'registry' });
  ctx.activity({ level: 'info', kind: 'mcp', projectId: pid, projectName: path.basename(dir), message: `Saved MCP definition ${valid.name}` });
  return { path: file };
}
