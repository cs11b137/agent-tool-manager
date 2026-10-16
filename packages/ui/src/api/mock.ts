import { ApiError, type ApiClient, type ConnectionStatus, type DryRunOpt, type McpDefScope, type TaskInfo, type TaskRef, type WriteOpt } from './client';
import { HOME, REGISTRY, ROOT, seed, type McpCat, type McpEntry, type MockProject, type MockState } from './mock-data';
import type {
  ActivityEntry,
  AddSpec,
  AgentId,
  AtmEvent,
  BatchOp,
  BatchResult,
  ContextBreakdown,
  DoctorIssue,
  DoctorReport,
  FileChange,
  GlobalConfig,
  SharedDirectoryInput,
  SharedRepositoryInput,
  SharedRepositoryStatus,
  CreateSharedToolInput,
  ToolPackageInput,
  ExternalToolQuery,
  ExternalToolSearchResult,
  ToolPackageResult,
  GlobalReport,
  LibraryItem,
  LibraryOptions,
  McpDef,
  MigrateSpec,
  ProjectDetail,
  ProjectSummary,
  RepoStatus,
  ToolEntry,
  ToolKind,
  WriteResult,
} from './types';
import { unifiedDiff } from '../lib/diff';
import { AGENT_LABEL, AGENT_MCP_FILE, tildify } from '../lib/format';

const clone = <T,>(v: T): T => structuredClone(v);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const mcpName = (e: McpEntry) => (typeof e === 'string' ? e : e.name);
const AGENT_ORDER: AgentId[] = ['claude-code', 'cursor', 'codex'];

function shortHome(p: string) {
  return tildify(p);
}

function hashId(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

export interface MockOptions {
  /** artificial latency in ms (0 in tests) */
  latency?: number;
  /** task step duration in ms */
  taskStep?: number;
}

/** In-memory implementation of ApiClient. Write ops really mutate state and return plausible diffs. */
export class MockApiClient implements ApiClient {
  readonly kind = 'mock' as const;
  private s: MockState = seed();
  private listeners = new Set<(e: AtmEvent) => void>();
  private tasks = new Map<string, TaskInfo & { timers: ReturnType<typeof setTimeout>[] }>();
  private taskSeq = 0;
  private config: GlobalConfig;
  private latency: number;
  private taskStep: number;

  constructor(opts: MockOptions = {}) {
    this.latency = opts.latency ?? 160;
    this.taskStep = opts.taskStep ?? 700;
    this.config = {
      root: ROOT,
      mcpRegistry: REGISTRY,
      defaultAgents: ['claude-code'],
      projects: this.s.projects.map((p) => p.path),
    };
  }

  // ───────────── helpers ─────────────

  private wait<T>(v: T): Promise<T> {
    const out = clone(v);
    if (!this.latency) return Promise.resolve(out);
    return new Promise((r) => setTimeout(() => r(out), this.latency * (0.6 + Math.random() * 0.8)));
  }

  private emit(e: AtmEvent) {
    setTimeout(() => this.listeners.forEach((l) => l(e)), 0);
  }

  private log(entry: Omit<ActivityEntry, 'at'>) {
    const full: ActivityEntry = { at: new Date().toISOString(), ...entry };
    this.s.activity.unshift(full);
    this.s.activity = this.s.activity.slice(0, 50);
    this.emit({ type: 'activity', entry: full });
  }

  private project(id: string): MockProject {
    const p = this.s.projects.find((x) => x.id === id || x.path === id || x.name === id);
    if (!p) throw new ApiError('NOT_FOUND', `项目 ${id} 不在注册表中`, { status: 404, nextCommand: 'atm init' });
    return p;
  }

  private live(id: string): MockProject {
    const p = this.project(id);
    if (!p.exists) {
      throw new ApiError('NOT_FOUND', `目录 ${shortHome(p.path)} 不存在`, {
        status: 404,
        nextCommand: `atm ui  # 在总览页「重新定位…」或从注册表移除`,
      });
    }
    return p;
  }

  private mcpCat(name: string): McpCat | undefined {
    return this.s.mcp.find((m) => m.def.name === name);
  }

  private mcpAgents(p: MockProject, e: McpEntry): AgentId[] {
    const want = typeof e === 'string' || !e.agents ? p.agents : e.agents;
    return AGENT_ORDER.filter((a) => want.includes(a) && p.agents.includes(a));
  }

  private context(p: MockProject): ContextBreakdown {
    if (!p.exists) return { skill: 0, mcp: 0, plugin: 0, total: 0, unmeasured: 0 };
    let skill = 0;
    let mcp = 0;
    let plugin = 0;
    let unmeasured = 0;
    for (const sk of p.skills) {
      const c = this.s.skills.find((x) => x.name === sk.name);
      if (c?.tokens == null) unmeasured++;
      else skill += c.tokens;
    }
    for (const e of p.mcp) {
      const c = this.mcpCat(mcpName(e));
      if (c?.tokens == null) unmeasured++;
      else mcp += c.tokens;
    }
    for (const name of p.plugins) {
      const c = this.s.plugins.find((x) => x.name === name);
      if (c?.tokens == null) unmeasured++;
      else plugin += c.tokens;
    }
    return { skill, mcp, plugin, total: skill + mcp + plugin, unmeasured };
  }

  // ───────────── rendering (what atm would write) ─────────────

  private renderMcpServer(def: McpDef, agent: AgentId): Record<string, unknown> {
    const ref = (v: string) => (agent === 'cursor' ? v.replace(/\$\{([A-Z0-9_]+)\}/g, '${env:$1}') : v);
    const mapVals = (o: Record<string, string> | undefined) =>
      o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ref(v)])) : undefined;
    if (def.transport === 'stdio') {
      return {
        ...(agent === 'claude-code' ? { type: 'stdio' } : {}),
        command: def.command,
        ...(def.args?.length ? { args: def.args } : {}),
        ...(def.env ? { env: mapVals(def.env) } : {}),
      };
    }
    return {
      ...(agent === 'claude-code' ? { type: 'http' } : {}),
      url: def.url,
      ...(def.headers ? { headers: mapVals(def.headers) } : {}),
    };
  }

  private renderCodex(p: MockProject): string {
    const out: string[] = [];
    const q = (v: string) => JSON.stringify(v.replace(/\$\{([A-Z0-9_]+)\}/g, '$$$1'));
    for (const e of p.mcp) {
      if (!this.mcpAgents(p, e).includes('codex')) continue;
      const c = this.mcpCat(mcpName(e));
      if (!c) continue;
      const d = c.def;
      out.push(`[mcp_servers.${d.name}]`);
      if (d.transport === 'stdio') {
        out.push(`command = ${JSON.stringify(d.command)}`);
        if (d.args?.length) out.push(`args = [${d.args.map((a) => JSON.stringify(a)).join(', ')}]`);
        if (d.env) {
          out.push('', `[mcp_servers.${d.name}.env]`);
          for (const [k, v] of Object.entries(d.env)) out.push(`${k} = ${q(v)}`);
        }
      } else {
        out.push(`url = ${JSON.stringify(d.url)}`);
        if (d.headers) {
          out.push('', `[mcp_servers.${d.name}.http_headers]`);
          for (const [k, v] of Object.entries(d.headers)) out.push(`${k} = ${q(v)}`);
        }
      }
      out.push('');
    }
    return out.join('\n');
  }

  private renderFiles(p: MockProject): Record<string, string> {
    const files: Record<string, string> = {};
    if (!p.initialized) return files;
    files['.agents/tools.json'] = json({
      agents: p.agents,
      skills: p.skills.map((s) => ({ repo: s.repo, name: s.name, ...(s.rev ? { rev: s.rev } : {}) })),
      mcp: p.mcp,
      plugins: p.plugins,
    });
    const managed: Record<string, { mcp: string[]; plugins: string[] }> = {};
    for (const a of p.agents) {
      managed[a] = {
        mcp: p.mcp.filter((e) => this.mcpAgents(p, e).includes(a)).map(mcpName),
        plugins: a === 'claude-code' ? [...p.plugins] : [],
      };
    }
    files['.agents/tools.lock.json'] = json({
      version: 1,
      skills: Object.fromEntries(
        p.skills.map((s) => {
          const c = this.s.skills.find((x) => x.name === s.name);
          return [
            s.name,
            { repo: s.repo, path: c?.path ?? '', commit: c?.commit ?? '', ...(s.rev ? { rev: s.rev } : {}), contextTokens: c?.tokens ?? 0 },
          ];
        }),
      ),
      mcp: Object.fromEntries(
        p.mcp.map((e) => {
          const c = this.mcpCat(mcpName(e));
          return [mcpName(e), { hash: c?.hash ?? '', ...(c?.tokens != null ? { contextTokens: c.tokens } : {}) }];
        }),
      ),
      managed,
    });
    for (const a of ['claude-code', 'cursor'] as const) {
      if (!p.agents.includes(a)) continue;
      const servers: Record<string, unknown> = { ...(p.handwritten[a] ?? {}) };
      for (const e of p.mcp) {
        if (!this.mcpAgents(p, e).includes(a)) continue;
        const c = this.mcpCat(mcpName(e));
        if (c) servers[c.def.name] = this.renderMcpServer(c.def, a);
      }
      files[a === 'claude-code' ? '.mcp.json' : '.cursor/mcp.json'] = json({ mcpServers: servers });
    }
    if (p.agents.includes('codex')) files['.codex/config.toml'] = this.renderCodex(p);
    if (p.agents.includes('claude-code') && p.plugins.length) {
      files['.claude/settings.json'] = json({ enabledPlugins: Object.fromEntries(p.plugins.map((n) => [n, true])), ...(p.plugins.some((n) => this.s.plugins.find((x) => x.name === n)?.localSource) ? { extraKnownMarketplaces: { 'atm-shared': { source: { source: 'directory', path: this.config.root } } } } : {}) });
    }
    return files;
  }

  private renderLinks(p: MockProject): Record<string, { target: string; broken: boolean }> {
    const links: Record<string, { target: string; broken: boolean }> = {};
    if (!p.initialized) return links;
    if (p.agents.includes('claude-code')) links['.claude/skills'] = { target: '../.agents/skills', broken: false };
    if (p.agents.includes('cursor')) links['.cursor/skills'] = { target: '../.agents/skills', broken: false };
    for (const s of p.skills) {
      const c = this.s.skills.find((x) => x.name === s.name);
      if (!c) continue;
      links[`.agents/skills/${s.name}`] = { target: `${c.repoDir}/${c.path}`, broken: p.broken.includes(s.name) };
    }
    return links;
  }

  private agentOf(rel: string): AgentId | undefined {
    if (rel === '.mcp.json' || rel.startsWith('.claude/')) return 'claude-code';
    if (rel.startsWith('.cursor/')) return 'cursor';
    if (rel.startsWith('.codex/')) return 'codex';
    return undefined;
  }

  private changes(before: MockProject, after: MockProject, includeUnchanged = false): FileChange[] {
    const out: FileChange[] = [];
    const bf = this.renderFiles(before);
    const af = this.renderFiles(after);
    const order = ['.agents/tools.json', '.agents/tools.lock.json', '.mcp.json', '.cursor/mcp.json', '.codex/config.toml', '.claude/settings.json'];
    const keys = [...new Set([...order.filter((k) => k in bf || k in af), ...Object.keys(bf), ...Object.keys(af)])];
    for (const rel of keys) {
      const b = bf[rel] ?? null;
      const a = af[rel] ?? null;
      if (b === a && !includeUnchanged) continue;
      const d = b === a ? { diff: '', additions: 0, deletions: 0 } : unifiedDiff(b, a, rel);
      const agent = this.agentOf(rel);
      out.push({
        path: `${after.path}/${rel}`,
        relPath: rel,
        type: 'file',
        before: b,
        after: a,
        ...d,
        ...(agent ? { agent } : {}),
      });
    }
    const bl = this.renderLinks(before);
    const al = this.renderLinks(after);
    for (const rel of [...new Set([...Object.keys(bl), ...Object.keys(al)])]) {
      const b = bl[rel];
      const a = al[rel];
      const same = b && a && b.target === a.target && b.broken === a.broken;
      if (same && !includeUnchanged) continue;
      const show = (t: string) => (t.startsWith('/') ? shortHome(t) : t);
      let diff: string;
      let additions = 0;
      let deletions = 0;
      if (same) diff = ` ${rel} → ${show(a.target)}`;
      else if (!b && a) {
        diff = `+${rel} → ${show(a.target)}`;
        additions = 1;
      } else if (b && !a) {
        diff = `-${rel} → ${show(b.target)}`;
        deletions = 1;
      } else {
        diff = `-${rel} → ${show(b!.target)}${b!.broken ? '（目标不存在）' : ''}\n+${rel} → ${show(a!.target)}`;
        additions = 1;
        deletions = 1;
      }
      const agent = this.agentOf(rel);
      out.push({
        path: `${after.path}/${rel}`,
        relPath: rel,
        type: 'symlink',
        target: (a ?? b)!.target,
        before: b ? b.target : null,
        after: a ? a.target : null,
        diff,
        additions,
        deletions,
        ...(agent ? { agent } : {}),
      });
    }
    return out;
  }

  private warningsFor(files: FileChange[], def?: McpDef): string[] {
    const w: string[] = [];
    const hasVars = def && ((def.transport === 'stdio' && def.env) || (def.transport === 'http' && def.headers));
    if (hasVars && files.some((f) => f.relPath === '.cursor/mcp.json')) {
      w.push('Cursor 的变量引用写法 ${env:VAR} 尚待验证（技术方案 §13-2），写入后建议在 Cursor 中确认一次。');
    }
    if (hasVars && files.some((f) => f.relPath === '.codex/config.toml')) {
      w.push('Codex 的变量引用写法 $VAR 尚待验证（技术方案 §13-2），写入后建议在 Codex 中确认一次。');
    }
    return w;
  }

  /** Apply spec to a cloned project; returns the command and the def for warnings. */
  private applyAdd(p: MockProject, spec: AddSpec, adopt = false): { command: string; def?: McpDef } {
    if (spec.kind === 'skill') {
      const c = this.s.skills.find((x) => x.name === spec.name && (x.repo === spec.repo || !spec.repo));
      if (!c) {
        throw new ApiError('NOT_FOUND', `在 ${spec.repo} 中找不到 Skill ${spec.name}`, {
          status: 404,
          nextCommand: `atm search ${spec.name}`,
          candidates: this.s.skills.map((x) => x.name),
        });
      }
      if (p.skills.some((x) => x.name === spec.name)) {
        throw new ApiError('ALREADY_EXISTS', `${p.name} 已经有 Skill ${spec.name}`, { status: 409, nextCommand: 'atm list' });
      }
      p.skills.push({ name: spec.name, repo: c.repo, ...(spec.rev ? { rev: spec.rev } : {}) });
      return { command: `atm add skill ${c.repo} ${spec.name}${spec.rev ? ` --rev ${spec.rev}` : ''}` };
    }
    if (spec.kind === 'mcp') {
      const c = this.mcpCat(spec.name);
      if (!c) throw new ApiError('NOT_FOUND', `registry 中没有 MCP 定义 ${spec.name}`, { status: 404, nextCommand: 'atm search ' + spec.name });
      if (p.mcp.some((e) => mcpName(e) === spec.name)) {
        throw new ApiError('ALREADY_EXISTS', `${p.name} 已经有 MCP ${spec.name}`, { status: 409, nextCommand: 'atm list' });
      }
      // a same-named hand-written entry in an agent file: CONFLICT unless the caller opted into --adopt
      const clash = p.agents.filter((a) => p.handwritten[a] && Object.hasOwn(p.handwritten[a]!, spec.name));
      if (clash.length && !adopt) {
        throw new ApiError('CONFLICT', `${clash.map((a) => AGENT_MCP_FILE[a]).join('、')} 中已有手写的 MCP \`${spec.name}\`，不在 atm 管理范围内`, {
          status: 409,
          nextCommand: `atm add mcp ${spec.name} --adopt`,
        });
      }
      for (const a of clash) delete p.handwritten[a]![spec.name];
      const agents = spec.agents?.filter((a) => p.agents.includes(a));
      const narrowed = agents && agents.length && agents.length < p.agents.length;
      p.mcp.push(narrowed ? { name: spec.name, agents } : spec.name);
      return { command: `atm add mcp ${spec.name}${spec.agents?.length ? ` --agents ${spec.agents.join(',')}` : ''}${clash.length ? ' --adopt' : ''}`, def: c.def };
    }
    const c = this.s.plugins.find((x) => x.name === spec.name || x.name.startsWith(`${spec.name}@`));
    if (!c) throw new ApiError('NOT_FOUND', `找不到插件 ${spec.name}`, { status: 404, nextCommand: 'claude plugin install ' + spec.name });
    if (!c.installed && !c.localSource) {
      throw new ApiError('PLUGIN_NOT_INSTALLED', `插件 ${c.name} 尚未安装`, { status: 400, nextCommand: `claude plugin install ${c.name}` });
    }
    if (p.plugins.includes(c.name)) {
      throw new ApiError('ALREADY_EXISTS', `${p.name} 已经启用插件 ${c.name}`, { status: 409, nextCommand: 'atm list' });
    }
    p.plugins.push(c.name);
    return { command: `atm add plugin ${c.name}` };
  }

  private applyRemove(p: MockProject, kind: ToolKind | undefined, name: string): { command: string; kind: ToolKind } {
    const hits: ToolKind[] = [];
    if (p.skills.some((s) => s.name === name)) hits.push('skill');
    if (p.mcp.some((e) => mcpName(e) === name)) hits.push('mcp');
    if (p.plugins.some((n) => n === name || n.startsWith(`${name}@`))) hits.push('plugin');
    const k = kind ?? (hits.length === 1 ? hits[0] : undefined);
    if (!kind && hits.length > 1) {
      throw new ApiError('AMBIGUOUS', `${name} 同时是 ${hits.join(' / ')}`, { status: 400, nextCommand: `atm remove ${name} --kind ${hits[0]}` });
    }
    if (!k || !hits.includes(k)) throw new ApiError('NOT_FOUND', `${p.name} 中没有 ${name}`, { status: 404, nextCommand: 'atm list' });
    if (k === 'skill') {
      p.skills = p.skills.filter((s) => s.name !== name);
      p.broken = p.broken.filter((b) => b !== name);
    } else if (k === 'mcp') p.mcp = p.mcp.filter((e) => mcpName(e) !== name);
    else p.plugins = p.plugins.filter((n) => n !== name && !n.startsWith(`${name}@`));
    return { command: `atm remove ${name}${kind ? ` --kind ${kind}` : ''}`, kind: k };
  }

  private commit(id: string, next: MockProject) {
    const i = this.s.projects.findIndex((x) => x.id === id);
    this.s.projects[i] = next;
    this.emit({ type: 'project.changed', projectId: id, reason: 'manifest' });
  }

  // ───────────── doctor ─────────────

  private issues(): DoctorIssue[] {
    const out: DoctorIssue[] = [];
    const live = this.s.projects.filter((p) => p.exists);
    for (const p of live) {
      for (const name of p.broken) {
        const c = this.s.skills.find((x) => x.name === name);
        out.push({
          id: `broken-link:${p.id}:skill:${name}`,
          level: 'error',
          code: 'broken-link',
          projectId: p.id,
          projectName: p.name,
          kind: 'skill',
          name,
          title: '断链',
          detail: `.agents/skills/${name} → ${shortHome(`${c?.repoDir ?? ROOT}/${c?.path ?? name}`)}（目标不存在）`,
          nextCommand: 'atm install',
          fixable: true,
        });
      }
    }
    const globalPlugins = this.s.plugins.filter((x) => x.globallyEnabled);
    for (const p of live) {
      if (!p.agents.includes('claude-code')) continue;
      for (const e of p.mcp) {
        const n = mcpName(e);
        const plug = [...globalPlugins, ...this.s.plugins.filter((x) => p.plugins.includes(x.name))].find((x) =>
          x.contents.mcp.includes(n),
        );
        if (!plug) continue;
        const tok = this.mcpCat(n)?.tokens;
        out.push({
          id: `mcp-dup-plugin:${p.id}:mcp:${n}`,
          level: 'warn',
          code: 'mcp-dup-plugin',
          projectId: p.id,
          projectName: p.name,
          kind: 'mcp',
          name: n,
          title: '与插件自带的 MCP 同名',
          detail: `清单里的 \`${n}\` 与已启用插件 \`${plug.name}\` 自带的 MCP 重名，Claude Code 会加载两份工具 schema${tok ? `（多占约 ${(tok / 1000).toFixed(1)}k tokens）` : ''}。`,
          nextCommand: `atm remove ${n}`,
          fixable: false,
        });
      }
    }
    for (const g of this.s.globalSkills) {
      for (const p of live.filter((x) => x.skills.some((s) => s.name === g.name))) {
        out.push({
          id: `skill-shadowed:${p.id}:skill:${g.name}`,
          level: 'warn',
          code: 'skill-shadowed',
          projectId: p.id,
          projectName: p.name,
          kind: 'skill',
          name: g.name,
          title: '与全局 Skill 同名',
          detail: `项目里的 \`${g.name}\` 与 \`~/.claude/skills/${g.name}\` 同名，Claude Code 会同时加载两份。`,
          nextCommand: '在「全局」页把它移到项目级',
          fixable: false,
        });
      }
    }
    for (const r of this.s.repos.filter((x) => x.dirty || x.ahead > 0)) {
      const users = live.filter((p) => p.skills.some((s) => s.repo === r.repo));
      out.push({
        id: `repo-dirty::repo:${r.repo}`,
        level: 'info',
        code: 'repo-dirty',
        name: r.repo,
        title: `\`${shortHome(r.dir)}\` 有未提交的改动`,
        detail:
          users.length > 1
            ? `共享仓库被 ${users.length} 个项目引用，改动已对${users.length === 2 ? '两者' : '它们'}生效；确认无误可以给上游提 PR`
            : '确认无误可以给上游提 PR',
        nextCommand: `git -C ${shortHome(r.dir)} status`,
        fixable: false,
      });
    }
    for (const g of globalPlugins) {
      const users = live.filter((p) => p.plugins.includes(g.name) || p.mcp.some((e) => g.contents.mcp.includes(mcpName(e))));
      if (users.length !== 1) continue;
      const u = users[0]!;
      out.push({
        id: `plugin-global-only:${u.id}:plugin:${g.name}`,
        level: 'info',
        code: 'plugin-global-only',
        projectId: u.id,
        projectName: u.name,
        kind: 'plugin',
        name: g.name,
        title: `插件 \`${g.name}\` 全局启用，但只有 ${u.name} 在用`,
        detail: '改为项目级后，其他项目的会话不再加载它',
        nextCommand: '在「全局」页使用「移到项目级」向导',
        fixable: false,
      });
    }
    for (const p of live) {
      const c = this.context(p);
      if (c.total < 5000) continue;
      const unm = p.mcp.map(mcpName).filter((n) => this.mcpCat(n)?.tokens == null);
      const parts = [`MCP 占 ${Math.round((c.mcp / c.total) * 100)}%`];
      if (unm.length) parts.push(`${unm.join('、')} 等未测量的 MCP 未计入`);
      out.push({
        id: `context-total:${p.id}::`,
        level: 'info',
        code: 'context-total',
        projectId: p.id,
        projectName: p.name,
        title: `${p.name} 工具总上下文 ≈ ${(c.total / 1000).toFixed(1)}k tokens`,
        detail: parts.join('；'),
        fixable: false,
      });
    }
    return out.filter((i) => !this.s.acknowledged.includes(i.id));
  }

  private report(issues: DoctorIssue[], projects: MockProject[], measured = false): DoctorReport {
    const counts = { error: 0, warn: 0, info: 0 };
    for (const i of issues) counts[i.level]++;
    return {
      checkedAt: new Date().toISOString(),
      measured,
      counts,
      issues,
      projects: projects.map((p) => ({ id: p.id, name: p.name, context: this.context(p) })),
    };
  }

  // ───────────── read model ─────────────

  private summary(p: MockProject): ProjectSummary {
    const zero = { skills: 0, mcp: 0, plugins: 0 };
    const doctor = { error: 0, warn: 0, info: 0 };
    if (p.exists) for (const i of this.issues().filter((x) => x.projectId === p.id)) doctor[i.level]++;
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      exists: p.exists,
      initialized: p.exists && p.initialized,
      agents: p.exists ? [...p.agents] : [],
      counts: p.exists ? { skills: p.skills.length, mcp: p.mcp.length, plugins: p.plugins.length } : zero,
      context: this.context(p),
      doctor,
    };
  }

  private tools(p: MockProject): ToolEntry[] {
    const out: ToolEntry[] = [];
    for (const s of p.skills) {
      const c = this.s.skills.find((x) => x.name === s.name);
      if (!c) continue;
      out.push({
        kind: 'skill',
        name: s.name,
        source: s.repo,
        agents: [...p.agents],
        contextTokens: c.tokens,
        enabled: true,
        skill: {
          repo: s.repo,
          path: c.path,
          commit: c.commit,
          ...(s.rev ? { rev: s.rev } : {}),
          ...(c.description ? { description: c.description } : {}),
          target: `${c.repoDir}/${c.path}`,
          linked: true,
          broken: p.broken.includes(s.name),
        },
      });
    }
    for (const e of p.mcp) {
      const c = this.mcpCat(mcpName(e));
      if (!c) continue;
      const d = c.def;
      const vars = new Set<string>();
      const values = d.transport === 'stdio' ? Object.values(d.env ?? {}) : Object.values(d.headers ?? {});
      for (const v of values) for (const m of v.matchAll(/\$\{([A-Z0-9_]+)\}/g)) vars.add(m[1]!);
      out.push({
        kind: 'mcp',
        name: d.name,
        source: c.origin,
        agents: this.mcpAgents(p, e),
        contextTokens: c.tokens,
        enabled: true,
        mcp: {
          transport: d.transport,
          ...(d.transport === 'stdio' ? { command: d.command, ...(d.args ? { args: d.args } : {}) } : { url: d.url }),
          origin: c.origin,
          hash: c.hash,
          ...(d.description ? { description: d.description } : {}),
          envVars: [...vars].map((name) => ({ name, set: this.s.env.includes(name) })),
        },
      });
    }
    for (const name of p.plugins) {
      const c = this.s.plugins.find((x) => x.name === name);
      const marketplace = name.split('@')[1] ?? '';
      out.push({
        kind: 'plugin',
        name,
        source: `@${marketplace}`,
        agents: p.agents.includes('claude-code') ? ['claude-code'] : [],
        contextTokens: c?.tokens ?? null,
        enabled: true,
        plugin: {
          marketplace,
          installed: c?.installed ?? false,
          ...(c?.version ? { version: c.version } : {}),
          globallyEnabled: c?.globallyEnabled ?? false,
          ...(c ? { contents: c.contents } : {}),
        },
      });
    }
    return out;
  }

  // ───────────── tasks ─────────────

  private runTask(title: string, steps: string[], done: () => unknown): TaskRef {
    const id = `t${++this.taskSeq}`;
    const task: TaskInfo & { timers: ReturnType<typeof setTimeout>[] } = { id, title, status: 'running', timers: [] };
    this.tasks.set(id, task);
    this.emit({ type: 'task.started', taskId: id, title });
    steps.forEach((message, i) => {
      task.timers.push(
        setTimeout(() => {
          const percent = Math.round(((i + 1) / (steps.length + 1)) * 100);
          task.progress = { message, percent };
          this.emit({ type: 'task.progress', taskId: id, message, percent });
        }, this.taskStep * (i + 0.5)),
      );
    });
    task.timers.push(
      setTimeout(() => {
        try {
          task.result = done();
          task.status = 'done';
          this.emit({ type: 'task.done', taskId: id, result: task.result });
        } catch (e) {
          task.status = 'failed';
          task.error = (e as Error).message;
          this.emit({ type: 'task.failed', taskId: id, error: task.error });
        }
      }, this.taskStep * (steps.length + 0.5)),
    );
    return { taskId: id };
  }

  // ───────────── ApiClient ─────────────

  async selectDirectory(_initialPath?: string): Promise<{ path: string | null }> {
    throw new ApiError('UNSUPPORTED', '演示模式不打开本机文件夹，请手动输入路径');
  }

  getConfig() {
    return this.wait({ ...this.config, projects: this.s.projects.map((p) => p.path) });
  }
  patchConfig(patch: Partial<GlobalConfig>) {
    this.config = { ...this.config, ...patch };
    return this.getConfig();
  }

  async initSharedDirectory(input: SharedDirectoryInput) {
    const normalize = (value: string) => {
      const clean = value.trim();
      if (!clean || clean.includes('\0') || !/^(\/|~(?:\/|$))/.test(clean)) {
        throw new ApiError('INVALID_MANIFEST', '请输入绝对路径或 ~/ 开头的路径', { status: 400 });
      }
      const parts: string[] = [];
      for (const part of clean.replace(/^~(?=\/|$)/, HOME).split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      return '/' + parts.join('/');
    };
    const patch = { root: normalize(input.root), mcpRegistry: normalize(input.mcpRegistry) };
    this.config = { ...this.config, ...patch };
    this.emit({ type: 'library.changed' });
    return this.getConfig();
  }

  private sharedRemote = '';
  private sharedHead = '';
  async getSharedRepository(): Promise<SharedRepositoryStatus> {
    return { initialized: true, root: this.config.root, remote: this.sharedRemote, branch: 'main', head: this.sharedHead, changes: this.sharedHead ? [] : ['README.md'], ahead: 0, registryIncluded: this.config.mcpRegistry.startsWith(this.config.root + '/') };
  }
  async initSharedRepository(input: SharedRepositoryInput): Promise<GlobalConfig> {
    const cfg = await this.initSharedDirectory(input);
    this.config.sharedRepository = true;
    if (input.defaultAgents) this.config.defaultAgents = [...input.defaultAgents];
    return { ...cfg, defaultAgents: this.config.defaultAgents, sharedRepository: true };
  }
  async setSharedRemote(remote: string) { this.sharedRemote = remote; return this.getSharedRepository(); }
  async commitSharedRepository(_message: string) { this.sharedHead = 'demo-commit'; return this.getSharedRepository(); }
  async pushSharedRepository() { return this.getSharedRepository(); }
  async searchExternalTools(_input: ExternalToolQuery): Promise<ExternalToolSearchResult> { return { items: [], warnings: ['演示模式不搜索外部工具，请连接本地服务。'] }; }

  async importToolPackage(_input: ToolPackageInput): Promise<ToolPackageResult> {
    throw new ApiError('UNSUPPORTED', '演示模式不安装外部工具包，请连接本地服务。');
  }

  async createSharedTool(input: CreateSharedToolInput) {
    if (input.kind === 'mcp') {
      if (this.s.mcp.some((c) => c.def.name === input.def.name)) throw new ApiError('ALREADY_EXISTS', '工具已存在');
      return this.saveMcpDef(input.def, 'registry');
    }
    const name = input.kind === 'plugin' ? `${input.name}@atm-shared` : input.name;
    if (this.s.skills.some((i) => input.kind === 'skill' && i.name === name) || this.s.plugins.some((i) => input.kind === 'plugin' && i.name === name)) throw new ApiError('ALREADY_EXISTS', '工具已存在');
    const rel = `${input.kind === 'skill' ? 'skills' : 'plugins'}/${input.name}`;
    if (input.kind === 'skill') this.s.skills.push({ name, repo: 'atm:shared', repoDir: this.config.root, path: rel, commit: '', tokens: 0, description: input.description });
    else this.s.plugins.push({ name, installed: false, localSource: true, tokens: 0, globallyEnabled: false, contents: { skills: [{ name: input.name, description: input.description, contextTokens: 0 }], mcp: [], commands: [], agents: [], hooks: false } });
    this.emit({ type: 'library.changed' });
    return { path: `${this.config.root}/${rel}` };
  }

  getProjects() {
    return this.wait(this.s.projects.map((p) => this.summary(p)));
  }

  registerProject(path: string) {
    const clean = path.trim().replace(/\/+$/, '').replace(/^~(?=\/|$)/, HOME);
    if (!clean.startsWith('/')) return Promise.reject(new ApiError('INVALID_MANIFEST', '请输入绝对路径或 ~/ 开头的路径', { status: 400, nextCommand: 'atm init' }));
    const existing = this.s.projects.find((p) => p.path === clean);
    if (existing) return this.wait(this.summary(existing));
    const p: MockProject = {
      id: hashId(clean),
      name: clean.split('/').pop() ?? clean,
      path: clean,
      exists: true,
      initialized: false,
      agents: [...this.config.defaultAgents],
      skills: [],
      mcp: [],
      plugins: [],
      broken: [],
      handwritten: {},
    };
    this.s.projects.push(p);
    this.emit({ type: 'project.changed', projectId: p.id, reason: 'registry' });
    return this.wait(this.summary(p));
  }

  unregisterProject(id: string) {
    const p = this.project(id);
    this.s.projects = this.s.projects.filter((x) => x.id !== p.id);
    this.log({ level: 'info', projectName: p.name, message: `已从注册表移除 ${shortHome(p.path)}（未删除任何文件）` });
    this.emit({ type: 'project.changed', projectId: p.id, reason: 'registry' });
    return this.wait({ ok: true as const });
  }

  async patchProject(id: string, patch: { path?: string; agents?: AgentId[] }, opts: DryRunOpt = {}): Promise<ProjectDetail | WriteResult> {
    const p = this.project(id);
    if (patch.path !== undefined) {
      const clean = patch.path.trim().replace(/\/+$/, '').replace(/^~(?=\/|$)/, HOME);
      if (!clean.startsWith('/')) throw new ApiError('INVALID_MANIFEST', '请输入绝对路径或 ~/ 开头的路径', { status: 400, nextCommand: 'atm ui' });
      const next = clone(p);
      next.path = clean;
      next.name = clean.split('/').pop() ?? clean;
      next.exists = true;
      if (!opts.dryRun) {
        this.commit(p.id, next);
        this.log({ level: 'info', projectId: p.id, projectName: next.name, message: `已重新定位到 ${shortHome(clean)}` });
      }
    }
    if (patch.agents) {
      const live = this.live(id);
      if (!patch.agents.length) throw new ApiError('INVALID_MANIFEST', '至少保留一个 Agent', { status: 400, nextCommand: 'atm install' });
      const next = clone(live);
      next.agents = AGENT_ORDER.filter((a) => patch.agents!.includes(a));
      next.broken = [];
      const files = this.changes(live, next);
      const res: WriteResult = {
        applied: !opts.dryRun,
        files,
        warnings: [],
        command: `atm install  # agents: ${next.agents.join(',')}`,
        contextAfter: this.context(next),
      };
      if (opts.dryRun) return this.wait(res);
      this.commit(live.id, next);
      this.log({ level: 'info', projectId: live.id, projectName: live.name, message: `落地 Agent 改为 ${next.agents.map((a) => AGENT_LABEL[a]).join('、')}` });
    }
    return this.getProject(p.id);
  }

  getProject(id: string): Promise<ProjectDetail> {
    try {
      const p = this.project(id);
      return this.wait({
        ...this.summary(p),
        manifestPath: `${p.path}/.agents/tools.json`,
        tools: p.exists ? this.tools(p) : [],
        issues: p.exists ? this.issues().filter((i) => i.projectId === p.id) : [],
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  async initProject(id: string, opts: WriteOpt = {}) {
    const p = this.live(id);
    const next = clone(p);
    next.initialized = true;
    const files = this.changes(p, next);
    if (!opts.dryRun) {
      this.commit(p.id, next);
      this.log({ level: 'info', projectId: p.id, projectName: p.name, message: '已执行 atm init' });
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [], command: `atm init${opts.force ? ' --force' : ''}`, contextAfter: this.context(next) });
  }

  async addTool(id: string, spec: AddSpec, opts: WriteOpt = {}) {
    const p = this.live(id);
    const next = clone(p);
    const { command, def } = this.applyAdd(next, spec, opts.adopt);
    const files = this.changes(p, next);
    const res: WriteResult = { applied: !opts.dryRun, files, warnings: this.warningsFor(files, def), command, contextAfter: this.context(next) };
    if (!opts.dryRun) {
      this.commit(p.id, next);
      const agents = spec.kind === 'mcp' ? this.mcpAgents(next, next.mcp[next.mcp.length - 1]!) : [];
      const suffix = spec.kind === 'mcp' && agents.length === 1 ? `（仅 ${AGENT_LABEL[agents[0]!]}）` : '';
      this.log({ level: 'info', kind: spec.kind, projectId: p.id, projectName: p.name, message: `通过 GUI 添加了 \`${spec.name}\`${suffix}` });
    }
    return this.wait(res);
  }

  async removeTool(id: string, kind: ToolKind, name: string, opts: DryRunOpt = {}) {
    const p = this.live(id);
    const next = clone(p);
    const { command } = this.applyRemove(next, kind, name);
    const files = this.changes(p, next);
    if (!opts.dryRun) {
      this.commit(p.id, next);
      this.log({ level: 'info', kind, projectId: p.id, projectName: p.name, message: `通过 GUI 移除了 \`${name}\`` });
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [], command, contextAfter: this.context(next) });
  }

  async install(id: string, opts: WriteOpt & { strict?: boolean } = {}) {
    const p = this.live(id);
    const next = clone(p);
    next.broken = [];
    const files = this.changes(p, next);
    const warnings: string[] = [];
    for (const s of p.skills) {
      const repo = this.s.repos.find((r) => r.repo === s.repo);
      if (repo?.dirty) warnings.push(`共享仓库 ${shortHome(repo.dir)} 有未提交的改动，lock 中的 commit 与工作区可能不一致。`);
    }
    if (!opts.dryRun) {
      this.commit(p.id, next);
      this.log({ level: 'info', projectId: p.id, projectName: p.name, message: files.length ? `install 完成，写入 ${files.length} 个文件` : 'install 完成，已是最新' });
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [...new Set(warnings)], command: `atm install${opts.strict ? ' --strict' : ''}${opts.adopt ? ' --adopt' : ''}${opts.force ? ' --force' : ''}`, contextAfter: this.context(next) });
  }

  getGenerated(id: string) {
    try {
      const p = this.live(id);
      const next = clone(p);
      next.broken = [];
      return this.wait(this.changes(p, next, true));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  measure(id: string, name: string) {
    const p = this.live(id);
    const c = this.mcpCat(name);
    if (!c) return Promise.reject(new ApiError('NOT_FOUND', `没有 MCP ${name}`, { status: 404, nextCommand: 'atm list' }));
    const ref = this.runTask(`测量 ${name}`, [`启动 ${name}`, 'initialize', 'tools/list'], () => {
      c.tokens = c.tokens ?? 2300;
      this.emit({ type: 'project.changed', projectId: p.id, reason: 'manifest' });
      this.emit({ type: 'library.changed' });
      return { name, contextTokens: c.tokens, toolCount: 18 };
    });
    return this.wait(ref);
  }

  async pin(id: string, skill: string, rev: string, opts: DryRunOpt = {}) {
    const p = this.live(id);
    const next = clone(p);
    const s = next.skills.find((x) => x.name === skill);
    if (!s) throw new ApiError('NOT_FOUND', `${p.name} 中没有 Skill ${skill}`, { status: 404, nextCommand: 'atm list' });
    s.rev = rev;
    const files = this.changes(p, next);
    if (!opts.dryRun) {
      this.commit(p.id, next);
      this.log({ level: 'info', kind: 'skill', projectId: p.id, projectName: p.name, message: `已将 \`${skill}\` 固定到 ${rev}` });
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [], command: `atm pin ${skill} ${rev}` });
  }

  getDoctor(id?: string, opts?: { measure?: false }): Promise<DoctorReport>;
  getDoctor(id: string | undefined, opts: { measure: true }): Promise<TaskRef>;
  getDoctor(id?: string, opts: { measure?: boolean } = {}): Promise<DoctorReport | TaskRef> {
    const scope = id ? [this.project(id)] : this.s.projects.filter((p) => p.exists);
    if (opts.measure) {
      const targets = scope.flatMap((p) => p.mcp.map(mcpName)).filter((n, i, a) => a.indexOf(n) === i);
      const ref = this.runTask(
        'doctor --measure',
        targets.length ? targets.map((n) => `测量 ${n}`) : ['检查清单'],
        () => {
          for (const n of targets) {
            const c = this.mcpCat(n);
            if (c && c.tokens == null) c.tokens = 2300;
          }
          for (const p of scope) this.emit({ type: 'project.changed', projectId: p.id, reason: 'manifest' });
          return this.report(this.issues(), scope, true);
        },
      );
      return this.wait(ref);
    }
    const all = this.issues();
    const issues = id ? all.filter((i) => i.projectId === scope[0]!.id) : all;
    return this.wait(this.report(issues, scope));
  }

  async fix(issueIds: string[], opts: DryRunOpt = {}) {
    const all = this.issues();
    const picked = all.filter((i) => issueIds.includes(i.id) && i.fixable);
    if (!picked.length) throw new ApiError('NOT_FOUND', '没有可安全修复的项', { status: 404, nextCommand: 'atm doctor' });
    const files: FileChange[] = [];
    const nexts = new Map<string, MockProject>();
    for (const i of picked) {
      const p = this.live(i.projectId!);
      const next = nexts.get(p.id) ?? clone(p);
      next.broken = next.broken.filter((b) => b !== i.name);
      nexts.set(p.id, next);
    }
    for (const [pid, next] of nexts) files.push(...this.changes(this.project(pid), next));
    if (!opts.dryRun) {
      for (const [pid, next] of nexts) this.commit(pid, next);
      for (const i of picked) {
        this.log({ level: 'info', kind: i.kind, projectId: i.projectId, projectName: i.projectName, message: `已重建软链 .agents/skills/${i.name}` });
      }
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [], command: 'atm install' });
  }

  getLibrary(q?: string, opts: LibraryOptions = {}) {
    const live = this.s.projects.filter((p) => p.exists);
    const items: LibraryItem[] = [];
    for (const c of this.s.skills) {
      const repo = this.s.repos.find((r) => r.repo === c.repo);
      const global = this.s.globalSkills.some((g) => g.name === c.name);
      items.push({
        kind: 'skill',
        name: c.name,
        ...(global && c.description ? { description: c.description } : {}),
        source: c.sourceLabel ?? c.repo,
        detail: c.path,
        contextTokens: c.tokens,
        usedBy: live.filter((p) => p.skills.some((s) => s.name === c.name)).map((p) => p.id),
        global,
        skill: { repo: c.repo, repoDir: repo?.dir ?? c.repoDir, path: c.path, commit: c.commit },
      });
    }
    for (const c of this.s.mcp) {
      const d = c.def;
      const vars = new Set<string>();
      const values = d.transport === 'stdio' ? Object.values(d.env ?? {}) : Object.values(d.headers ?? {});
      for (const v of values) for (const m of v.matchAll(/\$\{([A-Z0-9_]+)\}/g)) vars.add(m[1]!);
      items.push({
        kind: 'mcp',
        name: d.name,
        ...(d.description ? { description: d.description } : {}),
        source: c.origin,
        detail: d.transport === 'http' ? d.url : `${c.origin} · stdio · ${d.command}`,
        contextTokens: c.tokens,
        usedBy: live.filter((p) => p.mcp.some((e) => mcpName(e) === d.name)).map((p) => p.id),
        global: false,
        mcp: { transport: d.transport, origin: c.origin, envVars: [...vars].map((name) => ({ name, set: this.s.env.includes(name) })) },
      });
    }
    for (const c of this.s.plugins) {
      if (!opts.includeInstalledPlugins && !c.localSource && !live.some((p) => p.plugins.includes(c.name))) continue;
      const marketplace = c.name.split('@')[1] ?? '';
      items.push({
        kind: 'plugin',
        name: c.name,
        source: `@${marketplace}`,
        detail: `@${marketplace}${c.note ? ` · ${c.note}` : ''}`,
        contextTokens: c.tokens,
        usedBy: live.filter((p) => p.plugins.includes(c.name)).map((p) => p.id),
        global: c.globallyEnabled,
        plugin: { marketplace, installed: c.installed, ...(c.version ? { version: c.version } : {}), globallyEnabled: c.globallyEnabled, ...(c.localSource ? { localSource: true } : {}) },
      });
    }
    const needle = q?.trim().toLowerCase();
    const filtered = needle
      ? items.filter((i) => [i.name, i.source, i.description ?? '', i.detail ?? ''].some((s) => s.toLowerCase().includes(needle)))
      : items;
    return this.wait(filtered);
  }

  getRepos() {
    const live = this.s.projects.filter((p) => p.exists);
    return this.wait<RepoStatus[]>(
      this.s.repos.map((r) => ({
        ...r,
        usedBy: live.filter((p) => p.skills.some((s) => s.repo === r.repo)).map((p) => p.id),
      })),
    );
  }

  cloneRepo(repo: string) {
    const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
    if (!m) {
      return Promise.reject(new ApiError('INVALID_MANIFEST', `无法识别仓库地址 ${repo}`, { status: 400, nextCommand: 'atm ui  # 填 owner/repo 或 git URL' }));
    }
    const full = `${m[1]}/${m[2]}`;
    const dir = `${ROOT}/${m[2]}`;
    if (this.s.repos.some((r) => r.dir === dir)) {
      return Promise.reject(new ApiError('CONFLICT', `${shortHome(dir)} 已存在`, { status: 409, nextCommand: `git -C ${shortHome(dir)} remote -v` }));
    }
    const ref = this.runTask(`克隆 ${full}`, ['Cloning into …', 'Receiving objects', '扫描 SKILL.md'], () => {
      const head = hashId(full + Date.now()) + hashId(full).slice(0, 28);
      this.s.repos.push({ repo: full, dir, remote: `https://github.com/${full}.git`, head, branch: 'main', dirty: false, ahead: 0 });
      const skillName = m[2]!.replace(/-skills?$/, '') || m[2]!;
      if (!this.s.skills.some((s) => s.name === skillName)) {
        this.s.skills.push({ name: skillName, repo: full, repoDir: dir, path: `skills/${skillName}`, commit: head, tokens: 64 });
      }
      this.emit({ type: 'library.changed' });
      this.log({ level: 'info', kind: 'skill', projectName: '~/.agent-tools', message: `已克隆 \`${full}\` 到 ${shortHome(dir)}` });
      return { repo: full, dir };
    });
    return this.wait(ref);
  }

  sync(repos?: string[]) {
    const targets = this.s.repos.filter((r) => !repos?.length || repos.includes(r.repo));
    const ref = this.runTask(
      repos?.length ? `sync ${repos.join(', ')}` : '全部 sync',
      targets.map((r) => `git pull --ff-only · ${r.repo}`),
      () => {
        const result = targets.map((r) => ({
          repo: r.repo,
          dir: r.dir,
          status: r.dirty ? ('skipped-dirty' as const) : ('up-to-date' as const),
        }));
        for (const r of result) {
          this.log({
            level: r.status === 'skipped-dirty' ? 'warn' : 'info',
            kind: 'skill',
            projectName: '~/.agent-tools',
            message: r.status === 'skipped-dirty' ? `\`${r.repo}\` 有本地改动，已跳过 pull` : `\`${r.repo}\` 已是最新`,
          });
        }
        this.emit({ type: 'library.changed' });
        return { repos: result, updatedProjects: [] };
      },
    );
    return this.wait(ref);
  }

  saveMcpDef(def: McpDef, scope: McpDefScope) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(def.name)) {
      return Promise.reject(new ApiError('INVALID_MCP_DEF', '名称只能包含字母、数字、点、下划线和连字符', { status: 400, nextCommand: 'atm ui' }));
    }
    const vals = def.transport === 'stdio' ? Object.entries(def.env ?? {}) : Object.entries(def.headers ?? {});
    const bad = vals.find(([, v]) => !/\$\{[A-Z0-9_]+\}/.test(v));
    if (bad) {
      return Promise.reject(
        new ApiError('INVALID_MCP_DEF', `${bad[0]} 的值必须引用环境变量（如 \${${bad[0].toUpperCase()}}），不能写明文`, { status: 400, nextCommand: 'atm ui' }),
      );
    }
    if (this.mcpCat(def.name)) {
      return Promise.reject(new ApiError('ALREADY_EXISTS', `已存在 MCP 定义 ${def.name}`, { status: 409, nextCommand: `atm search ${def.name}` }));
    }
    const origin = scope === 'registry' ? 'registry' : 'project';
    const path = scope === 'registry' ? `${REGISTRY}/${def.name}.json` : `${this.project(scope.projectId).path}/.agents/mcp/${def.name}.json`;
    this.s.mcp.push({ def: clone(def), origin, hash: `sha256:${hashId(JSON.stringify(def))}${hashId(def.name)}`, tokens: null });
    this.emit({ type: 'library.changed' });
    this.log({ level: 'info', kind: 'mcp', projectName: origin === 'registry' ? 'registry' : undefined, message: `新建 MCP 定义 \`${def.name}\`` });
    return this.wait({ path });
  }

  async batch(ops: BatchOp[], opts: WriteOpt = {}): Promise<BatchResult> {
    const working = new Map<string, MockProject>();
    const results: BatchResult['results'] = [];
    for (const op of ops) {
      try {
        const base = working.get(op.projectId) ?? clone(this.live(op.projectId));
        const next = clone(base);
        let command: string;
        let def: McpDef | undefined;
        if (op.action === 'add') ({ command, def } = this.applyAdd(next, op.spec as AddSpec, opts.adopt));
        else ({ command } = this.applyRemove(next, op.spec.kind, op.spec.name));
        const files = this.changes(base, next);
        working.set(op.projectId, next);
        results.push({
          projectId: op.projectId,
          result: { applied: !opts.dryRun, files, warnings: this.warningsFor(files, def), command, contextAfter: this.context(next) },
        });
      } catch (e) {
        results.push({ projectId: op.projectId, result: { error: (e as Error).message } });
      }
    }
    if (!opts.dryRun) {
      for (const [pid, next] of working) this.commit(pid, next);
      ops.forEach((op, i) => {
        const r = results[i]!.result;
        if ('error' in r) return;
        const p = this.project(op.projectId);
        this.log({
          level: 'info',
          kind: op.spec.kind,
          projectId: p.id,
          projectName: p.name,
          message: `通过矩阵${op.action === 'add' ? '启用' : '停用'}了 \`${op.spec.name}\``,
        });
      });
    }
    return this.wait({ applied: !opts.dryRun, results });
  }

  getGlobal() {
    const live = this.s.projects.filter((p) => p.exists);
    return this.wait<GlobalReport>({
      skills: this.s.globalSkills.map((g) => ({
        name: g.name,
        path: g.path,
        target: g.target,
        contextTokens: g.tokens,
        shadowedBy: live.filter((p) => p.skills.some((s) => s.name === g.name)).map((p) => p.id),
      })),
      plugins: this.s.plugins
        .filter((x) => x.globallyEnabled)
        .map((x) => ({
          name: x.name,
          installed: x.installed,
          contextTokens: x.tokens,
          usedBy: live.filter((p) => p.plugins.includes(x.name) || p.mcp.some((e) => x.contents.mcp.includes(mcpName(e)))).map((p) => p.id),
        })),
    });
  }

  private globalSettings(): string {
    return json({ enabledPlugins: Object.fromEntries(this.s.plugins.filter((x) => x.globallyEnabled).map((x) => [x.name, true])) });
  }

  async migrate(spec: MigrateSpec, opts: WriteOpt = {}) {
    if (!spec.projectIds.length) throw new ApiError('INVALID_MANIFEST', '至少选择一个项目', { status: 400, nextCommand: 'atm ui' });
    const files: FileChange[] = [];
    const nexts: Array<[string, MockProject]> = [];
    const commands: string[] = [];
    for (const pid of spec.projectIds) {
      const p = this.live(pid);
      const next = clone(p);
      let addSpec: AddSpec;
      if (spec.kind === 'skill') {
        const c = this.s.skills.find((x) => x.name === spec.name);
        if (!c) throw new ApiError('NOT_FOUND', `找不到 Skill ${spec.name} 的来源仓库`, { status: 404, nextCommand: `atm search ${spec.name}` });
        addSpec = { kind: 'skill', repo: c.repo, name: c.name };
      } else addSpec = { kind: 'plugin', name: spec.name };
      const already = spec.kind === 'skill' ? next.skills.some((s) => s.name === spec.name) : next.plugins.includes(spec.name);
      if (!already) commands.push(`cd ${shortHome(p.path)} && ${this.applyAdd(next, addSpec).command}`);
      files.push(...this.changes(p, next));
      nexts.push([pid, next]);
    }
    let globalChange: (() => void) | undefined;
    if (spec.removeGlobal) {
      if (spec.kind === 'plugin') {
        const before = this.globalSettings();
        const plug = this.s.plugins.find((x) => x.name === spec.name);
        if (plug) {
          plug.globallyEnabled = false;
          const after = this.globalSettings();
          plug.globallyEnabled = true;
          files.push({
            path: `${HOME}/.claude/settings.json`,
            relPath: '~/.claude/settings.json',
            type: 'file',
            before,
            after,
            ...unifiedDiff(before, after, '.claude/settings.json'),
            agent: 'claude-code',
          });
          globalChange = () => {
            plug.globallyEnabled = false;
          };
        }
      } else {
        const g = this.s.globalSkills.find((x) => x.name === spec.name);
        if (g) {
          files.push({
            path: g.path,
            relPath: `~/.claude/skills/${g.name}`,
            type: 'symlink',
            target: g.target,
            before: g.target,
            after: null,
            diff: `-~/.claude/skills/${g.name} → ${shortHome(g.target)}`,
            additions: 0,
            deletions: 1,
            agent: 'claude-code',
          });
          globalChange = () => {
            this.s.globalSkills = this.s.globalSkills.filter((x) => x.name !== g.name);
          };
        }
      }
      commands.push(spec.kind === 'plugin' ? `claude plugin disable ${spec.name} --scope user` : `rm ~/.claude/skills/${spec.name}`);
    }
    if (!opts.dryRun) {
      for (const [pid, next] of nexts) this.commit(pid, next);
      globalChange?.();
      this.emit({ type: 'library.changed' });
      this.log({
        level: 'info',
        kind: spec.kind,
        message: `已把 \`${spec.name}\` 移到 ${nexts.map(([, n]) => n.name).join('、')} 的项目级清单${spec.removeGlobal ? '，并从全局移除' : ''}`,
      });
    }
    return this.wait<WriteResult>({ applied: !opts.dryRun, files, warnings: [], command: commands.join(' ; ') });
  }

  getActivity() {
    return this.wait(this.s.activity);
  }

  getTask(id: string) {
    const t = this.tasks.get(id);
    if (!t) return Promise.reject(new ApiError('NOT_FOUND', `任务 ${id} 不存在`, { status: 404 }));
    const { timers: _t, ...info } = t;
    return this.wait<TaskInfo>(info);
  }

  async cancelTask(id: string) {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return;
    t.timers.forEach(clearTimeout);
    t.status = 'cancelled';
    this.emit({ type: 'task.cancelled', taskId: id });
  }

  subscribe(onEvent: (e: AtmEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void {
    this.listeners.add(onEvent);
    onStatus?.('connecting');
    const t = setTimeout(() => onStatus?.('open'), 50);
    return () => {
      clearTimeout(t);
      this.listeners.delete(onEvent);
      onStatus?.('closed');
    };
  }
}
