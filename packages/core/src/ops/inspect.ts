import path from 'node:path';
import type {
  AgentId,
  ContextBreakdown,
  DoctorCounts,
  DoctorIssue,
  GlobalConfig,
  LockFile,
  ProjectDetail,
  ProjectSummary,
  ToolEntry,
  ToolsManifest,
} from '../types.js';
import { ADAPTERS } from '../adapters/index.js';
import { parseDoc } from '../adapters/merge.js';
import { compactHome, projectId, type Ctx } from '../context.js';
import { errorMessage } from '../errors.js';
import { linkState } from '../fs/symlink.js';
import { isDir, readText } from '../fs/walk.js';
import { git } from '../git.js';
import { emptyLock, mcpRefAgents, mcpRefName, paths, readProjectFiles, resolveWorktree } from '../manifest.js';
import { envVarStatus, hashMcpDef, loadDefs, type DefSet } from '../mcp/registry.js';
import { hitLevel, scanServer, scanServers, type SecretHit } from '../mcp/secrets.js';
import { globalSkillNames, loadPluginIndex, splitPluginId, type PluginIndex } from '../plugins/index.js';
import { readSkillMeta } from '../skills/discover.js';
import { locateRepo, type RepoLocation } from '../skills/resolver.js';
import { skillTokens } from '../tokens.js';
import { ENTRY_TARGET } from './project.js';

/** 跨项目共享的只读数据（一次 doctor / projects 调用内复用）。 */
export interface Shared {
  cfg: GlobalConfig;
  plugins: PluginIndex;
  registry: DefSet;
  globalSkills: Set<string>;
  /** 所有已注册且已初始化项目的清单 */
  manifests: Map<string, { dir: string; manifest: ToolsManifest }>;
  repoInfo: Map<string, Promise<RepoInfo>>;
  /** repo spec → 本机目录（被别的仓库占用时 dir 为 null） */
  repoLocs: Map<string, Promise<RepoLocation>>;
}

export function repoLocation(ctx: Ctx, shared: Shared, spec: string): Promise<RepoLocation> {
  let p = shared.repoLocs.get(spec);
  if (!p) {
    p = locateRepo(ctx, shared.cfg.root, spec);
    shared.repoLocs.set(spec, p);
  }
  return p;
}

/** lock 里的 worktree → 绝对路径；解析到 `<root>` 之外时返回错误信息。 */
function worktreeOf(root: string, worktree: string | undefined): { dir: string | null; error?: string } {
  if (!worktree) return { dir: null };
  try {
    return { dir: resolveWorktree(root, worktree) };
  } catch (e) {
    return { dir: null, error: errorMessage(e) };
  }
}

interface RepoInfo {
  head: string | null;
  dirty: boolean;
  ahead: number;
}

export async function loadShared(ctx: Ctx, cfg: GlobalConfig): Promise<Shared> {
  const manifests = new Map<string, { dir: string; manifest: ToolsManifest }>();
  for (const dir of cfg.projects) {
    try {
      const f = await readProjectFiles(dir);
      if (f.manifest) manifests.set(projectId(dir), { dir, manifest: f.manifest });
    } catch {
      // 无效清单在 doctor 中单独体现
    }
  }
  return {
    cfg,
    plugins: await loadPluginIndex(ctx),
    registry: await loadDefs(cfg.mcpRegistry),
    globalSkills: new Set(await globalSkillNames(ctx)),
    manifests,
    repoInfo: new Map(),
    repoLocs: new Map(),
  };
}

function repoInfo(ctx: Ctx, shared: Shared, dir: string): Promise<RepoInfo> {
  let p = shared.repoInfo.get(dir);
  if (!p) {
    p = (async () => ({
      head: await git.tryHead(dir, ctx.signal),
      dirty: await git.isDirty(dir, ctx.signal),
      ahead: await git.ahead(dir, ctx.signal),
    }))();
    shared.repoInfo.set(dir, p);
  }
  return p;
}

export function zeroContext(): ContextBreakdown {
  return { skill: 0, mcp: 0, plugin: 0, total: 0, unmeasured: 0 };
}

export function contextOf(tools: ToolEntry[], extraUnmeasured = 0): ContextBreakdown {
  const c = zeroContext();
  c.unmeasured = extraUnmeasured;
  for (const t of tools) {
    if (t.contextTokens === null) {
      c.unmeasured++;
      continue;
    }
    c[t.kind === 'skill' ? 'skill' : t.kind === 'mcp' ? 'mcp' : 'plugin'] += t.contextTokens;
  }
  c.total = c.skill + c.mcp + c.plugin;
  return c;
}

export function countIssues(issues: DoctorIssue[]): DoctorCounts {
  const c: DoctorCounts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) c[i.level]++;
  return c;
}

export async function buildTools(
  ctx: Ctx,
  shared: Shared,
  dir: string,
  manifest: ToolsManifest,
  lock: LockFile,
  defs: DefSet,
): Promise<ToolEntry[]> {
  const tools: ToolEntry[] = [];
  for (const ref of manifest.skills) {
    const locked = lock.skills[ref.name];
    const relPath = locked?.path ?? ref.name;
    const wt = worktreeOf(shared.cfg.root, locked?.worktree);
    // 仓库目录被别的仓库占用 / worktree 不合法：不读那里的内容，按断链/缺链报告
    const loc = locked?.worktree ? null : await repoLocation(ctx, shared, ref.repo);
    const expected = wt.dir ? path.join(wt.dir, relPath) : loc?.dir ? path.join(loc.dir, relPath) : null;
    const st = await linkState(path.join(paths.skillsDir(dir), ref.name));
    const meta = expected ? await readSkillMeta(st.kind === 'symlink' && !st.broken ? st.resolved : expected) : null;
    const info: NonNullable<ToolEntry['skill']> = {
      repo: ref.repo,
      path: relPath,
      commit: locked?.commit ?? '',
      target: st.kind === 'symlink' ? st.resolved : (expected ?? ''),
      linked: st.kind === 'symlink',
      broken: st.kind === 'symlink' && (st.broken || expected === null),
    };
    if (ref.rev) info.rev = ref.rev;
    if (meta?.description) info.description = meta.description;
    tools.push({
      kind: 'skill',
      name: ref.name,
      source: ref.repo,
      agents: [...manifest.agents],
      contextTokens: locked?.contextTokens ?? skillTokens(ref.name, meta?.description),
      enabled: true,
      skill: info,
    });
  }
  for (const ref of manifest.mcp) {
    const name = mcpRefName(ref);
    const loaded = defs.defs.get(name);
    const entry: ToolEntry = {
      kind: 'mcp',
      name,
      source: loaded ? loaded.origin : 'missing',
      agents: mcpRefAgents(ref, manifest),
      contextTokens: lock.mcp[name]?.contextTokens ?? null,
      enabled: true,
    };
    if (loaded) {
      const d = loaded.def;
      const info: NonNullable<ToolEntry['mcp']> = {
        transport: d.transport,
        origin: loaded.origin,
        hash: hashMcpDef(d),
        envVars: envVarStatus(d, ctx.env),
      };
      if (d.transport === 'stdio') {
        info.command = d.command;
        if (d.args) info.args = d.args;
      } else info.url = d.url;
      if (d.description) info.description = d.description;
      entry.mcp = info;
    }
    tools.push(entry);
  }
  for (const name of manifest.plugins) {
    const inst = shared.plugins.installed.get(name);
    const info: NonNullable<ToolEntry['plugin']> = {
      marketplace: splitPluginId(name).marketplace,
      installed: Boolean(inst),
      globallyEnabled: shared.plugins.globallyEnabled.has(name),
    };
    if (inst?.version) info.version = inst.version;
    if (inst?.installPath) info.installPath = inst.installPath;
    const contents = await shared.plugins.contents(name);
    if (contents) info.contents = contents;
    tools.push({
      kind: 'plugin',
      name,
      source: info.marketplace ? `@${info.marketplace}` : 'plugin',
      agents: manifest.agents.includes('claude-code') ? ['claude-code'] : [],
      contextTokens: await shared.plugins.contextTokens(name, lock.mcp),
      enabled: true,
      plugin: info,
    });
  }
  return tools;
}

function issue(
  code: DoctorIssue['code'],
  level: DoctorIssue['level'],
  pid: string | undefined,
  pname: string | undefined,
  kind: DoctorIssue['kind'],
  name: string | undefined,
  title: string,
  extra: Partial<DoctorIssue> = {},
): DoctorIssue {
  const out: DoctorIssue = {
    id: [code, pid ?? '', kind ?? '', name ?? ''].join(':'),
    level,
    code,
    title,
    // 只有缺失 / 断掉的软链可以安全修复，由调用方显式标记
    fixable: false,
    ...extra,
  };
  if (pid) out.projectId = pid;
  if (pname) out.projectName = pname;
  if (kind) out.kind = kind;
  if (name) out.name = name;
  return out;
}

interface ConfigScan {
  hits: Array<{ file: string; server: string; level: 'error' | 'warn' }>;
  unparseable: Array<{ file: string; agent: AgentId; error: string }>;
}

async function scanGeneratedConfigs(dir: string): Promise<ConfigScan> {
  const out: ConfigScan = { hits: [], unparseable: [] };
  for (const agent of Object.keys(ADAPTERS) as AgentId[]) {
    const a = ADAPTERS[agent];
    const text = await readText(path.join(dir, a.mcpFile));
    if (text === null) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parseDoc(text, a.format, a.mcpFile);
    } catch (e) {
      out.unparseable.push({ file: a.mcpFile, agent, error: errorMessage(e) });
      continue;
    }
    const byServer = new Map<string, SecretHit[]>();
    for (const h of scanServers(doc[a.serversKey])) byServer.set(h.server, [...(byServer.get(h.server) ?? []), h]);
    for (const [server, hits] of byServer) out.hits.push({ file: a.mcpFile, server, level: hitLevel(hits)! });
  }
  return out;
}

/** 单个项目的 doctor 检查（不含 measure）。 */
export async function projectIssues(
  ctx: Ctx,
  shared: Shared,
  dir: string,
  manifest: ToolsManifest,
  lock: LockFile,
  defs: DefSet,
  tools: ToolEntry[],
): Promise<DoctorIssue[]> {
  const pid = projectId(dir);
  const pname = path.basename(dir);
  const issues: DoctorIssue[] = [];
  const add = (...args: Parameters<typeof issue>) => issues.push(issue(...args));

  // 软链：只有「缺失」或「断掉」的软链标记为 fixable（fix = 对该项目执行 install 的 Skill 部分）
  for (const t of tools) {
    if (t.kind !== 'skill' || !t.skill) continue;
    const rel = `.agents/skills/${t.name}`;
    const st = await linkState(path.join(paths.skillsDir(dir), t.name));
    const locked = lock.skills[t.name];
    const wt = worktreeOf(shared.cfg.root, locked?.worktree);
    const loc = locked?.worktree ? null : await repoLocation(ctx, shared, t.skill.repo);
    const unresolvable = wt.error ?? (loc && !loc.dir ? (loc.reason ?? `cannot locate ${t.skill.repo}`) : undefined);
    if (st.kind === 'dir' || st.kind === 'file') {
      add('skill-dir-conflict', 'error', pid, pname, 'skill', t.name, `${rel} is a real ${st.kind === 'dir' ? 'directory' : 'file'}, not a symlink`, {
        detail: `atm manages ${rel} as a symlink into the shared repo; a real ${st.kind === 'dir' ? 'directory' : 'file'} is in the way and will not be touched automatically`,
        nextCommand: `move ${rel} away (or rename the skill), then atm install`,
      });
    } else if (unresolvable) {
      add(st.kind === 'symlink' ? 'broken-link' : 'missing-link', 'error', pid, pname, 'skill', t.name, `Skill ${t.name}: shared repo ${t.skill.repo} cannot be used`, {
        detail: unresolvable,
        nextCommand: wt.error ? 'remove the worktree field from .agents/tools.lock.json, then atm install' : `move the occupying directory away (or clone ${t.skill.repo} elsewhere), then atm install`,
      });
    } else if (st.kind === 'missing') {
      add('missing-link', 'error', pid, pname, 'skill', t.name, `Skill ${t.name} is not linked`, {
        detail: `${rel} does not exist`,
        nextCommand: 'atm install',
        fixable: true,
      });
    } else if (st.broken) {
      add('broken-link', 'error', pid, pname, 'skill', t.name, `Skill ${t.name} link is broken`, {
        detail: `${rel} -> ${t.skill.target} does not exist`,
        nextCommand: 'atm install',
        fixable: true,
      });
    }
  }
  for (const agent of manifest.agents) {
    const entry = ADAPTERS[agent].skillEntry;
    if (!entry) continue;
    const st = await linkState(path.join(dir, entry));
    if (st.kind === 'missing') {
      add('missing-link', 'error', pid, pname, 'skill', entry, `${entry} is missing`, { nextCommand: 'atm install', fixable: true });
    } else if (st.kind === 'symlink' && st.broken) {
      add('broken-link', 'error', pid, pname, 'skill', entry, `${entry} is a broken symlink`, {
        detail: `${entry} -> ${st.target} does not exist`,
        nextCommand: 'atm install',
        fixable: true,
      });
    } else if (st.kind === 'symlink' && st.target !== ENTRY_TARGET && st.resolved !== paths.skillsDir(dir)) {
      add('broken-link', 'error', pid, pname, 'skill', entry, `${entry} does not point to .agents/skills`, {
        detail: `${entry} -> ${st.target}; replacing a working symlink needs --force`,
        nextCommand: 'atm install --force',
      });
    } else if (st.kind === 'dir' || st.kind === 'file') {
      add('skill-dir-conflict', 'error', pid, pname, 'skill', entry, `${entry} is a real ${st.kind === 'dir' ? 'directory' : 'file'}`, {
        detail:
          st.kind === 'dir'
            ? `${entry} should be a symlink to .agents/skills; atm init migrates its contents into .agents/skills`
            : `${entry} should be a symlink to .agents/skills; remove the file first`,
        nextCommand: st.kind === 'dir' ? 'atm init' : `rm ${entry} && atm install`,
      });
    }
  }

  // 明文密钥：项目内定义、引用的 registry 定义、已生成的配置
  const usedMcp = new Set(manifest.mcp.map(mcpRefName));
  for (const r of defs.raw) {
    const name = path.basename(r.file, '.json');
    if (r.origin === 'registry' && !usedMcp.has(name)) continue;
    const level = hitLevel(scanServer(name, r.raw));
    if (level) {
      add('plaintext-secret', level, pid, pname, 'mcp', `${name}@${compactHome(ctx.home, r.file)}`, `${level === 'error' ? 'Plaintext secret' : 'Possible secret'} in MCP definition ${name}`, {
        detail:
          level === 'error'
            ? `${compactHome(ctx.home, r.file)} contains a literal secret; use \${VAR} instead`
            : `${compactHome(ctx.home, r.file)} has a secret-looking value in args/url; use \${VAR} instead`,
        nextCommand: `edit ${compactHome(ctx.home, r.file)}`,
      });
    }
  }
  const scan = await scanGeneratedConfigs(dir);
  for (const h of scan.hits) {
    add('plaintext-secret', h.level, pid, pname, 'mcp', `${h.server}@${h.file}`, `${h.level === 'error' ? 'Plaintext secret' : 'Possible secret'} in ${h.file} (${h.server})`, {
      detail:
        h.level === 'error'
          ? `${h.file} → ${h.server} contains a literal secret; use a variable reference instead`
          : `${h.file} → ${h.server} has a secret-looking value in args/url; use a variable reference instead`,
      nextCommand: `edit ${h.file}`,
    });
  }
  for (const u of scan.unparseable) {
    add('config-unparseable', 'error', pid, pname, undefined, u.file, `${u.file} cannot be parsed`, {
      detail: `${u.error} — atm cannot update it or scan it for secrets`,
      nextCommand: `fix the syntax of ${u.file}`,
    });
  }

  // 全局同名 Skill
  for (const s of manifest.skills) {
    if (shared.globalSkills.has(s.name)) {
      add('skill-shadowed', 'warn', pid, pname, 'skill', s.name, `Skill ${s.name} also exists in ~/.claude/skills`, {
        detail: 'A global skill with the same name may shadow the project skill',
        nextCommand: `rm ~/.claude/skills/${s.name}`,
      });
    }
  }

  // 插件
  const enabledPlugins = new Set([...shared.plugins.globallyEnabled, ...manifest.plugins]);
  for (const name of manifest.plugins) {
    if (!shared.plugins.installed.has(name)) {
      add('plugin-not-installed', 'error', pid, pname, 'plugin', name, `Plugin ${name} is not installed`, {
        nextCommand: `/plugin install ${name}`,
      });
    }
  }
  for (const pl of enabledPlugins) {
    const contents = await shared.plugins.contents(pl);
    for (const m of contents?.mcp ?? []) {
      if (usedMcp.has(m)) {
        add('mcp-dup-plugin', 'warn', pid, pname, 'mcp', m, `MCP ${m} is also provided by plugin ${pl}`, {
          detail: `The enabled plugin ${pl} ships an MCP server named ${m}`,
          nextCommand: `atm remove ${m} --kind mcp`,
        });
      }
    }
  }
  for (const name of manifest.plugins) {
    if (!shared.plugins.globallyEnabled.has(name)) continue;
    const users = [...shared.manifests.entries()].filter(([, v]) => v.manifest.plugins.includes(name)).map(([id]) => id);
    if (users.every((id) => id === pid)) {
      add('plugin-global-only', 'info', pid, pname, 'plugin', name, `Plugin ${name} is enabled globally but only used here`, {
        detail: 'Consider disabling it in ~/.claude/settings.json and keeping it project-level',
        nextCommand: `remove "${name}" from enabledPlugins in ~/.claude/settings.json`,
      });
    }
  }

  // 仓库状态
  const repoDirs = new Map<string, string>();
  for (const s of manifest.skills) {
    const locked = lock.skills[s.name];
    const repoDir = (await repoLocation(ctx, shared, s.repo)).dir;
    if (!repoDir || !(await isDir(repoDir))) continue;
    repoDirs.set(repoDir, s.repo);
    if (!locked?.commit) continue;
    const wt = worktreeOf(shared.cfg.root, locked.worktree);
    if (locked.worktree && !wt.dir) continue;
    const head = wt.dir ? await git.tryHead(wt.dir, ctx.signal) : (await repoInfo(ctx, shared, repoDir)).head;
    if (head && !head.startsWith(locked.commit) && !locked.commit.startsWith(head)) {
      add('rev-mismatch', 'warn', pid, pname, 'skill', s.name, `Skill ${s.name}: repo is at ${head.slice(0, 7)}, lock has ${locked.commit.slice(0, 7)}`, {
        nextCommand: `atm add skill ${s.repo} ${s.name}`,
      });
    }
  }
  for (const [repoDir, repo] of repoDirs) {
    const info = await repoInfo(ctx, shared, repoDir);
    if (info.dirty || info.ahead > 0) {
      add('repo-dirty', 'info', pid, pname, undefined, repo, `Shared repo ${repo} has local changes`, {
        detail: info.dirty ? 'Uncommitted changes — consider opening a PR upstream' : `${info.ahead} unpushed commit(s) — consider opening a PR upstream`,
        nextCommand: `git -C ${compactHome(ctx.home, repoDir)} status`,
      });
    }
  }

  const ctxSum = contextOf(tools, await pluginUnmeasured(shared.plugins, manifest, lock));
  add('context-total', 'info', pid, pname, undefined, undefined, `Context ≈ ${ctxSum.total} tokens${ctxSum.unmeasured ? ` (+${ctxSum.unmeasured} unmeasured)` : ''}`, {
    detail: `skills ${ctxSum.skill} · mcp ${ctxSum.mcp} · plugins ${ctxSum.plugin}`,
    ...(ctxSum.unmeasured ? { nextCommand: 'atm doctor --measure' } : {}),
  });
  return issues;
}

export interface ProjectSnapshot {
  summary: ProjectSummary;
  detail?: ProjectDetail;
}

/** 读一个项目的全部视图数据（ProjectDetail，或目录不存在/未初始化时的 ProjectSummary）。 */
export async function inspectProject(ctx: Ctx, shared: Shared, dir: string): Promise<ProjectSnapshot> {
  const id = projectId(dir);
  const base: ProjectSummary = {
    id,
    name: path.basename(dir),
    path: dir,
    exists: await isDir(dir),
    initialized: false,
    agents: [],
    counts: { skills: 0, mcp: 0, plugins: 0 },
    context: zeroContext(),
    doctor: { error: 0, warn: 0, info: 0 },
  };
  // 契约：目录不存在 → exists:false，其余字段取零值（问题本身由 doctor 的 project-missing 报告）
  if (!base.exists) return { summary: base };
  let files;
  try {
    files = await readProjectFiles(dir);
  } catch {
    base.initialized = true;
    base.doctor.error = 1;
    return { summary: base };
  }
  if (!files.manifest) return { summary: base };
  const manifest = files.manifest;
  const lock = files.lock ?? emptyLock();
  const defs = await loadDefs(shared.cfg.mcpRegistry, dir);
  const tools = await buildTools(ctx, shared, dir, manifest, lock, defs);
  const issues = await projectIssues(ctx, shared, dir, manifest, lock, defs, tools);
  const summary: ProjectSummary = {
    ...base,
    initialized: true,
    agents: [...manifest.agents],
    counts: { skills: manifest.skills.length, mcp: manifest.mcp.length, plugins: manifest.plugins.length },
    context: contextOf(tools, await pluginUnmeasured(shared.plugins, manifest, lock)),
    doctor: countIssues(issues),
  };
  return { summary, detail: { ...summary, manifestPath: paths.manifest(dir), tools, issues } };
}

export function missingProjectIssue(dir: string): DoctorIssue {
  const pid = projectId(dir);
  return issue('project-missing', 'error', pid, path.basename(dir), undefined, undefined, `Project directory not found: ${dir}`, {
    nextCommand: 'relocate or unregister the project (atm ui)',
  });
}

/** 清单中插件内含、但未测量的 MCP 数量。 */
export async function pluginUnmeasured(idx: PluginIndex, manifest: ToolsManifest, lock: LockFile): Promise<number> {
  let n = 0;
  for (const name of manifest.plugins) n += await idx.unmeasuredMcp(name, lock.mcp);
  return n;
}

/** 只根据清单 + lock 估算上下文（写操作的 contextAfter）。 */
export async function contextFor(ctx: Ctx, manifest: ToolsManifest, lock: LockFile, plugins?: PluginIndex): Promise<ContextBreakdown> {
  const idx = plugins ?? (await loadPluginIndex(ctx));
  const c = zeroContext();
  for (const s of manifest.skills) c.skill += lock.skills[s.name]?.contextTokens ?? 0;
  for (const ref of manifest.mcp) {
    const t = lock.mcp[mcpRefName(ref)]?.contextTokens;
    if (t === undefined) c.unmeasured++;
    else c.mcp += t;
  }
  for (const name of manifest.plugins) {
    const t = await idx.contextTokens(name, lock.mcp);
    if (t === null) c.unmeasured++;
    else c.plugin += t;
    c.unmeasured += await idx.unmeasuredMcp(name, lock.mcp);
  }
  c.total = c.skill + c.mcp + c.plugin;
  return c;
}
