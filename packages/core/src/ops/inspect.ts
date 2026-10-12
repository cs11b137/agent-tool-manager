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
import { linkState } from '../fs/symlink.js';
import { isDir, readText } from '../fs/walk.js';
import { git } from '../git.js';
import { emptyLock, mcpRefAgents, mcpRefName, paths, readProjectFiles } from '../manifest.js';
import { envVarStatus, hashMcpDef, loadDefs, type DefSet } from '../mcp/registry.js';
import { scanServer, scanServers } from '../mcp/secrets.js';
import { globalSkillNames, loadPluginIndex, splitPluginId, type PluginIndex } from '../plugins/index.js';
import { readSkillMeta } from '../skills/discover.js';
import { locateRepoDir } from '../skills/resolver.js';
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

export function contextOf(tools: ToolEntry[]): ContextBreakdown {
  const c = zeroContext();
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
    const repoDir = await locateRepoDir(ctx, shared.cfg.root, ref.repo);
    const relPath = locked?.path ?? ref.name;
    const target = locked?.worktree ? path.join(locked.worktree, relPath) : path.join(repoDir, relPath);
    const st = await linkState(path.join(paths.skillsDir(dir), ref.name));
    const meta = await readSkillMeta(st.kind === 'symlink' && !st.broken ? st.resolved : target);
    const info: NonNullable<ToolEntry['skill']> = {
      repo: ref.repo,
      path: relPath,
      commit: locked?.commit ?? '',
      target: st.kind === 'symlink' ? st.resolved : target,
      linked: st.kind === 'symlink',
      broken: st.kind === 'symlink' && st.broken,
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
      contextTokens: await shared.plugins.contextTokens(name),
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
    fixable: code === 'broken-link' || code === 'missing-link',
    ...extra,
  };
  if (pid) out.projectId = pid;
  if (pname) out.projectName = pname;
  if (kind) out.kind = kind;
  if (name) out.name = name;
  return out;
}

async function scanGeneratedConfigs(dir: string): Promise<Array<{ file: string; server: string }>> {
  const hits: Array<{ file: string; server: string }> = [];
  for (const agent of Object.keys(ADAPTERS) as AgentId[]) {
    const a = ADAPTERS[agent];
    const text = await readText(path.join(dir, a.mcpFile));
    if (text === null) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parseDoc(text, a.format, a.mcpFile);
    } catch {
      continue;
    }
    for (const h of scanServers(doc[a.serversKey])) hits.push({ file: a.mcpFile, server: h.server });
  }
  return hits;
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

  // 软链
  for (const t of tools) {
    if (t.kind !== 'skill' || !t.skill) continue;
    if (!t.skill.linked) {
      add('missing-link', 'error', pid, pname, 'skill', t.name, `Skill ${t.name} is not linked`, {
        detail: `.agents/skills/${t.name} does not exist`,
        nextCommand: 'atm install',
      });
    } else if (t.skill.broken) {
      add('broken-link', 'error', pid, pname, 'skill', t.name, `Skill ${t.name} link is broken`, {
        detail: `.agents/skills/${t.name} -> ${t.skill.target} does not exist`,
        nextCommand: 'atm install',
      });
    }
  }
  for (const agent of manifest.agents) {
    const entry = ADAPTERS[agent].skillEntry;
    if (!entry) continue;
    const st = await linkState(path.join(dir, entry));
    if (st.kind === 'missing') {
      add('missing-link', 'error', pid, pname, 'skill', entry, `${entry} is missing`, { nextCommand: 'atm install' });
    } else if (st.kind === 'symlink' && (st.broken || (st.target !== ENTRY_TARGET && st.resolved !== paths.skillsDir(dir)))) {
      add('broken-link', 'error', pid, pname, 'skill', entry, `${entry} does not point to .agents/skills`, {
        detail: `${entry} -> ${st.target}`,
        nextCommand: 'atm install',
      });
    }
  }

  // 明文密钥：项目内定义、引用的 registry 定义、已生成的配置
  const usedMcp = new Set(manifest.mcp.map(mcpRefName));
  for (const r of defs.raw) {
    const name = path.basename(r.file, '.json');
    if (r.origin === 'registry' && !usedMcp.has(name)) continue;
    if (scanServer(name, r.raw).length) {
      add('plaintext-secret', 'error', pid, pname, 'mcp', `${name}@${compactHome(ctx.home, r.file)}`, `Plaintext secret in MCP definition ${name}`, {
        detail: `${compactHome(ctx.home, r.file)} contains a literal secret; use \${VAR} instead`,
        nextCommand: `edit ${compactHome(ctx.home, r.file)}`,
      });
    }
  }
  for (const h of await scanGeneratedConfigs(dir)) {
    add('plaintext-secret', 'error', pid, pname, 'mcp', `${h.server}@${h.file}`, `Plaintext secret in ${h.file} (${h.server})`, {
      detail: `${h.file} → ${h.server} contains a literal secret; use a variable reference instead`,
      nextCommand: `edit ${h.file}`,
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
    const repoDir = await locateRepoDir(ctx, shared.cfg.root, s.repo);
    if (!(await isDir(repoDir))) continue;
    repoDirs.set(repoDir, s.repo);
    if (!locked?.commit) continue;
    const head = locked.worktree ? await git.tryHead(locked.worktree, ctx.signal) : (await repoInfo(ctx, shared, repoDir)).head;
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

  const ctxSum = contextOf(tools);
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
    context: contextOf(tools),
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
    const t = await idx.contextTokens(name);
    if (t === null) c.unmeasured++;
    else c.plugin += t;
  }
  c.total = c.skill + c.mcp + c.plugin;
  return c;
}
