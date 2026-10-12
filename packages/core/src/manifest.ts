import path from 'node:path';
import type { AgentId, LockFile, LockedMcp, LockedSkill, ManagedEntries, McpRef, SkillRef, ToolsManifest } from './types.js';
import { ALL_AGENTS } from './types.js';
import { AtmError } from './errors.js';
import { readText } from './fs/walk.js';

export const MANIFEST_SCHEMA = 'https://atm.dev/schema/tools.v1.json';

export const paths = {
  agentsDir: (dir: string) => path.join(dir, '.agents'),
  manifest: (dir: string) => path.join(dir, '.agents', 'tools.json'),
  lock: (dir: string) => path.join(dir, '.agents', 'tools.lock.json'),
  skillsDir: (dir: string) => path.join(dir, '.agents', 'skills'),
  projectMcpDir: (dir: string) => path.join(dir, '.agents', 'mcp'),
  writeLock: (dir: string) => path.join(dir, '.agents', '.lock'),
};

/** Skill / MCP 名：会被拼进路径（`.agents/skills/<name>`、`.agents/mcp/<name>.json`），必须是单个安全的路径段。 */
export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 插件 id：`<plugin>@<marketplace>` */
export const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME.test(name) && name !== '.' && name !== '..';
}

export function isPluginId(id: unknown): id is string {
  return typeof id === 'string' && PLUGIN_ID.test(id);
}

export const NAME_RULE = 'letters, digits, ".", "_" or "-", starting with a letter or digit';

/** 校验写操作传入的名字（add / batch）。 */
export function assertToolName(kind: 'skill' | 'mcp' | 'plugin', name: string): void {
  const ok = kind === 'plugin' ? isPluginId(name) : isToolName(name);
  if (!ok) {
    throw new AtmError('INVALID_MANIFEST', kind === 'plugin' ? `invalid plugin id ${JSON.stringify(name)} (expected <plugin>@<marketplace>, each part ${NAME_RULE})` : `invalid ${kind} name ${JSON.stringify(name)} (${NAME_RULE})`, {
      nextCommand: kind === 'skill' ? 'atm search <name>' : 'atm list',
    });
  }
}

/**
 * lock 中的 worktree（相对 `<root>`）→ 绝对路径。
 * 拒绝解析到 `<root>` 之外的值；旧版本写下的、位于 `<root>` 内的绝对路径仍然接受。
 */
export function resolveWorktree(root: string, worktree: string): string {
  const abs = path.resolve(root, worktree);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AtmError('INVALID_MANIFEST', `.agents/tools.lock.json: worktree ${JSON.stringify(worktree)} resolves outside ${root}`, {
      nextCommand: 'remove the worktree field from .agents/tools.lock.json, then atm install',
    });
  }
  return abs;
}

/** worktree 的绝对路径 → 写进 lock 的相对 `<root>` 形式。 */
export function relativeWorktree(root: string, abs: string): string {
  return path.relative(root, resolveWorktree(root, abs));
}

function invalid(file: string, msg: string): AtmError {
  return new AtmError('INVALID_MANIFEST', `${file}: ${msg}`, { nextCommand: `fix ${file} and run atm install` });
}

function isAgent(v: unknown): v is AgentId {
  return typeof v === 'string' && (ALL_AGENTS as readonly string[]).includes(v);
}

function agentList(v: unknown, file: string, where: string): AgentId[] {
  if (!Array.isArray(v)) throw invalid(file, `${where} must be an array`);
  for (const a of v) if (!isAgent(a)) throw invalid(file, `${where}: unknown agent ${JSON.stringify(a)} (expected ${ALL_AGENTS.join(', ')})`);
  return [...new Set(v as AgentId[])];
}

/** 校验并规范化 tools.json；缺失的数组字段补成 []。 */
export function validateManifest(raw: unknown, file = '.agents/tools.json'): ToolsManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(file, 'must be a JSON object');
  const r = raw as Record<string, unknown>;
  const agents = r.agents === undefined ? [] : agentList(r.agents, file, 'agents');
  const skills: SkillRef[] = [];
  if (r.skills !== undefined) {
    if (!Array.isArray(r.skills)) throw invalid(file, 'skills must be an array');
    for (const [i, s] of r.skills.entries()) {
      if (!s || typeof s !== 'object') throw invalid(file, `skills[${i}] must be an object`);
      const o = s as Record<string, unknown>;
      if (typeof o.repo !== 'string' || !o.repo) throw invalid(file, `skills[${i}].repo must be a non-empty string`);
      if (typeof o.name !== 'string' || !o.name) throw invalid(file, `skills[${i}].name must be a non-empty string`);
      if (!isToolName(o.name)) throw invalid(file, `skills[${i}].name ${JSON.stringify(o.name)} is not a valid name (${NAME_RULE})`);
      if (o.rev !== undefined && typeof o.rev !== 'string') throw invalid(file, `skills[${i}].rev must be a string`);
      if (skills.some((x) => x.name === o.name)) throw invalid(file, `duplicate skill ${o.name}`);
      const ref: SkillRef = { repo: o.repo, name: o.name };
      if (o.rev) ref.rev = o.rev as string;
      skills.push(ref);
    }
  }
  const mcp: Array<string | McpRef> = [];
  if (r.mcp !== undefined) {
    if (!Array.isArray(r.mcp)) throw invalid(file, 'mcp must be an array');
    for (const [i, m] of r.mcp.entries()) {
      let ref: string | McpRef;
      if (typeof m === 'string' && m) ref = m;
      else if (m && typeof m === 'object' && typeof (m as McpRef).name === 'string' && (m as McpRef).name) {
        const o = m as Record<string, unknown>;
        ref = { name: o.name as string };
        if (o.agents !== undefined) ref.agents = agentList(o.agents, file, `mcp[${i}].agents`);
      } else throw invalid(file, `mcp[${i}] must be a name or { name, agents? }`);
      const name = mcpRefName(ref);
      if (!isToolName(name)) throw invalid(file, `mcp[${i}] name ${JSON.stringify(name)} is not a valid name (${NAME_RULE})`);
      if (mcp.some((x) => mcpRefName(x) === name)) throw invalid(file, `duplicate mcp ${name}`);
      mcp.push(ref);
    }
  }
  const plugins: string[] = [];
  if (r.plugins !== undefined) {
    if (!Array.isArray(r.plugins)) throw invalid(file, 'plugins must be an array');
    for (const [i, p] of r.plugins.entries()) {
      if (typeof p !== 'string' || !p) throw invalid(file, `plugins[${i}] must be a non-empty string`);
      if (!isPluginId(p)) throw invalid(file, `plugins[${i}] ${JSON.stringify(p)} is not a valid plugin id (expected <plugin>@<marketplace>)`);
      if (!plugins.includes(p)) plugins.push(p);
    }
  }
  const out: ToolsManifest = { agents, skills, mcp, plugins };
  if (typeof r.$schema === 'string') out.$schema = r.$schema;
  return out;
}

export function mcpRefName(ref: string | McpRef): string {
  return typeof ref === 'string' ? ref : ref.name;
}

export function mcpRefAgents(ref: string | McpRef, manifest: ToolsManifest): AgentId[] {
  return typeof ref === 'string' || !ref.agents ? manifest.agents : ref.agents;
}

export function serializeManifest(m: ToolsManifest): string {
  const out: Record<string, unknown> = {};
  if (m.$schema) out.$schema = m.$schema;
  out.agents = m.agents;
  out.skills = m.skills.map((s) => (s.rev ? { repo: s.repo, name: s.name, rev: s.rev } : { repo: s.repo, name: s.name }));
  out.mcp = m.mcp.map((r) => (typeof r === 'string' ? r : r.agents ? { name: r.name, agents: r.agents } : r.name));
  out.plugins = m.plugins;
  return JSON.stringify(out, null, 2) + '\n';
}

export function emptyManifest(agents: AgentId[]): ToolsManifest {
  return { $schema: MANIFEST_SCHEMA, agents: [...agents], skills: [], mcp: [], plugins: [] };
}

export function emptyLock(): LockFile {
  return { version: 1, skills: {}, mcp: {}, managed: {} };
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function validateLock(raw: unknown, file = '.agents/tools.lock.json'): LockFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(file, 'must be a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw invalid(file, `unsupported lock version ${JSON.stringify(r.version)}`);
  const lock = emptyLock();
  const skills = (r.skills ?? {}) as Record<string, unknown>;
  if (typeof skills !== 'object' || Array.isArray(skills)) throw invalid(file, 'skills must be an object');
  for (const [name, v] of Object.entries(skills)) {
    if (!isToolName(name)) throw invalid(file, `skill name ${JSON.stringify(name)} is not a valid name (${NAME_RULE})`);
    const o = v as Record<string, unknown>;
    if (!o || typeof o.repo !== 'string' || typeof o.path !== 'string') throw invalid(file, `skills.${name} needs repo and path`);
    const s: LockedSkill = {
      repo: o.repo,
      path: o.path,
      commit: typeof o.commit === 'string' ? o.commit : '',
      contextTokens: typeof o.contextTokens === 'number' ? o.contextTokens : 0,
    };
    if (typeof o.rev === 'string') s.rev = o.rev;
    if (typeof o.worktree === 'string') {
      // 与 <root> 无关的部分在这里就能拒绝：`..` 逃逸；绝对路径（旧格式）留到使用时按 <root> 校验
      const norm = path.normalize(o.worktree);
      if (!path.isAbsolute(norm) && (norm === '.' || norm === '..' || norm.startsWith('..' + path.sep))) {
        throw invalid(file, `skills.${name}.worktree ${JSON.stringify(o.worktree)} must stay inside the shared repo root`);
      }
      s.worktree = o.worktree;
    }
    lock.skills[name] = s;
  }
  const mcp = (r.mcp ?? {}) as Record<string, unknown>;
  if (typeof mcp !== 'object' || Array.isArray(mcp)) throw invalid(file, 'mcp must be an object');
  for (const [name, v] of Object.entries(mcp)) {
    if (!isToolName(name)) throw invalid(file, `mcp name ${JSON.stringify(name)} is not a valid name (${NAME_RULE})`);
    const o = v as Record<string, unknown>;
    if (!o || typeof o.hash !== 'string') throw invalid(file, `mcp.${name} needs hash`);
    const m: LockedMcp = { hash: o.hash };
    if (typeof o.contextTokens === 'number') m.contextTokens = o.contextTokens;
    lock.mcp[name] = m;
  }
  const managed = (r.managed ?? {}) as Record<string, unknown>;
  for (const [agent, v] of Object.entries(managed)) {
    if (!isAgent(agent)) continue;
    const o = (v ?? {}) as Record<string, unknown>;
    lock.managed[agent] = { mcp: strArray(o.mcp), plugins: strArray(o.plugins) };
  }
  return lock;
}

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k]!;
  return out;
}

export function serializeLock(lock: LockFile): string {
  const skills: Record<string, LockedSkill> = {};
  for (const [name, s] of Object.entries(sortedRecord(lock.skills))) {
    const o: LockedSkill = { repo: s.repo, path: s.path, commit: s.commit } as LockedSkill;
    if (s.rev) o.rev = s.rev;
    o.contextTokens = s.contextTokens;
    if (s.worktree) o.worktree = s.worktree;
    skills[name] = o;
  }
  const mcp: Record<string, LockedMcp> = {};
  for (const [name, m] of Object.entries(sortedRecord(lock.mcp))) {
    mcp[name] = m.contextTokens === undefined ? { hash: m.hash } : { hash: m.hash, contextTokens: m.contextTokens };
  }
  const managed: Partial<Record<AgentId, ManagedEntries>> = {};
  for (const agent of ALL_AGENTS) {
    const e = lock.managed[agent];
    if (e && (e.mcp.length || e.plugins.length)) managed[agent] = { mcp: [...e.mcp].sort(), plugins: [...e.plugins].sort() };
  }
  return JSON.stringify({ version: 1, skills, mcp, managed }, null, 2) + '\n';
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalid(file, `invalid JSON: ${(e as Error).message}`);
  }
}

export interface ProjectFiles {
  manifest: ToolsManifest | null;
  manifestText: string | null;
  lock: LockFile;
  lockText: string | null;
}

export async function readProjectFiles(dir: string): Promise<ProjectFiles> {
  const manifestText = await readText(paths.manifest(dir));
  const lockText = await readText(paths.lock(dir));
  const manifest = manifestText === null ? null : validateManifest(parseJson(manifestText, '.agents/tools.json'));
  const lock = lockText === null ? emptyLock() : validateLock(parseJson(lockText, '.agents/tools.lock.json'));
  return { manifest, manifestText, lock, lockText };
}

export async function requireManifest(dir: string): Promise<ProjectFiles & { manifest: ToolsManifest }> {
  const files = await readProjectFiles(dir);
  if (!files.manifest) {
    throw new AtmError('NOT_INITIALIZED', `${dir} has no .agents/tools.json`, { nextCommand: `atm init` });
  }
  return files as ProjectFiles & { manifest: ToolsManifest };
}
