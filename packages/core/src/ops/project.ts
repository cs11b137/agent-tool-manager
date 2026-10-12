import path from 'node:path';
import type { AgentId, GlobalConfig, LockFile, LockedSkill, ToolsManifest, WriteOptions } from '../types.js';
import { ALL_AGENTS } from '../types.js';
import { ADAPTERS } from '../adapters/index.js';
import { mergeIntoFile } from '../adapters/merge.js';
import { AtmError } from '../errors.js';
import { linkState } from '../fs/symlink.js';
import { exists, isDir, readText } from '../fs/walk.js';
import { git } from '../git.js';
import { emptyLock, mcpRefAgents, mcpRefName, paths, serializeLock, serializeManifest, type ProjectFiles } from '../manifest.js';
import { hashMcpDef, loadDefs, requireDef } from '../mcp/registry.js';
import { locateRepoDir, type SkillResolver } from '../skills/resolver.js';
import type { Planner } from './planner.js';

export interface ProjectPlanInput {
  cfg: GlobalConfig;
  dir: string;
  files: ProjectFiles;
  /** 期望状态（已应用本次修改的清单） */
  manifest: ToolsManifest;
  opts: WriteOptions & { strict?: boolean };
  resolver: SkillResolver;
  /** install：全部 Skill 重新解析（克隆缺失仓库、比对 lock） */
  resolveAll?: boolean;
  /** 强制重新解析的 Skill（add 同名时） */
  forceResolve?: Set<string>;
  /** 追加 .gitignore（init / install） */
  gitignore?: boolean;
  /** 由调用方处理的入口软链（init 迁移） */
  skipEntries?: Set<string>;
  /** 只规划 Skill 部分（fix） */
  skillsOnly?: boolean;
  /** 冲突提示中「加 --adopt 重试」的命令 */
  retryCommand: string;
}

export const ENTRY_TARGET = path.join('..', '.agents', 'skills');

function skillTarget(repoDir: string, s: LockedSkill): string {
  return s.worktree ? path.join(s.worktree, s.path) : path.join(repoDir, s.path);
}

async function planSkills(p: Planner, input: ProjectPlanInput, lockOut: LockFile): Promise<void> {
  const { dir, manifest, files, resolver, cfg, opts } = input;
  const skillsDir = paths.skillsDir(dir);
  if (!(await isDir(skillsDir))) p.mkdir(skillsDir);

  for (const ref of manifest.skills) {
    const old = files.lock.skills[ref.name];
    const sameRef = old && old.repo === ref.repo && (old.rev ?? '') === (ref.rev ?? '');
    const force = input.forceResolve?.has(ref.name) ?? false;
    let locked: LockedSkill;
    let target: string;
    let resolvedNow = false;
    if (old && sameRef && old.worktree && !force) {
      // 已 pin：保持指向 worktree
      locked = { ...old };
      target = skillTarget('', old);
      if (input.resolveAll && !(await exists(old.worktree))) {
        const co = await resolver.checkout(ref.repo);
        const wt = old.worktree;
        p.exec(wt, `git worktree add ${p.rel(wt)} ${old.rev ?? old.commit}`, async () => {
          await git.worktreeAdd(co.dir, wt, old.rev ?? old.commit);
        });
        resolvedNow = true;
      }
    } else if (old && sameRef && !force && !input.resolveAll) {
      locked = { ...old };
      target = skillTarget(await locateRepoDir(p.ctx, cfg.root, ref.repo), old);
    } else {
      const r = await resolver.resolve(ref);
      resolvedNow = true;
      for (const w of r.warnings) p.warn(w);
      locked = r.locked;
      if (old && sameRef && input.resolveAll && !force) {
        if (old.commit && r.checkout.head && !r.checkout.head.startsWith(old.commit) && !old.commit.startsWith(r.checkout.head)) {
          const msg = `${ref.name}: shared repo ${ref.repo} is at ${r.checkout.head.slice(0, 7)}, lock has ${old.commit.slice(0, 7)}`;
          if (opts.strict) throw new AtmError('REV_MISMATCH', msg, { nextCommand: 'atm sync' });
          p.warn(msg);
        }
        // install 不改写 lock 中的 commit（由 sync 更新）
        locked.commit = old.commit || locked.commit;
      }
      target = skillTarget(r.checkout.dir, locked);
    }
    lockOut.skills[ref.name] = locked;

    const linkPath = path.join(skillsDir, ref.name);
    const st = await linkState(linkPath);
    if (st.kind === 'symlink') {
      if (st.target !== target) p.symlink(linkPath, st.target, target);
    } else if (st.kind === 'missing') {
      if (!resolvedNow && !(await exists(target))) {
        // 未重新解析且仓库不在本机：不建断链，提示 install
        p.warn(`${ref.name}: ${p.rel(target)} does not exist; run atm install`);
      } else {
        p.symlink(linkPath, null, target);
      }
    } else {
      throw new AtmError('CONFLICT', `.agents/skills/${ref.name} is a real ${st.kind === 'dir' ? 'directory' : 'file'}, not a symlink`, {
        nextCommand: `move .agents/skills/${ref.name} away, then atm install`,
      });
    }
  }

  // 清单里已删除、lock 里还记录着的 Skill：删软链（只删软链，不碰实体目录）
  for (const name of Object.keys(files.lock.skills)) {
    if (manifest.skills.some((s) => s.name === name)) continue;
    const linkPath = path.join(skillsDir, name);
    const st = await linkState(linkPath);
    if (st.kind === 'symlink') p.unlink(linkPath, st.target);
  }
}

async function planEntryLinks(p: Planner, input: ProjectPlanInput): Promise<void> {
  const { dir, manifest, opts } = input;
  for (const agent of manifest.agents) {
    const entry = ADAPTERS[agent].skillEntry;
    if (!entry || input.skipEntries?.has(entry)) continue;
    const linkPath = path.join(dir, entry);
    const st = await linkState(linkPath);
    if (st.kind === 'symlink') {
      if (st.target === ENTRY_TARGET) continue;
      if (st.resolved === paths.skillsDir(dir)) continue;
      if (!opts.force) {
        throw new AtmError('CONFLICT', `${entry} points to ${st.target}, expected ${ENTRY_TARGET}`, {
          nextCommand: `${input.retryCommand} --force`,
        });
      }
      p.symlink(linkPath, st.target, ENTRY_TARGET, agent);
    } else if (st.kind === 'missing') {
      p.symlink(linkPath, null, ENTRY_TARGET, agent);
    } else {
      throw new AtmError('CONFLICT', `${entry} is a real ${st.kind === 'dir' ? 'directory' : 'file'}`, {
        nextCommand: 'atm init',
      });
    }
  }
}

async function planMcp(p: Planner, input: ProjectPlanInput, lockOut: LockFile): Promise<void> {
  const { dir, manifest, files, cfg, opts } = input;
  const defs = await loadDefs(cfg.mcpRegistry, dir);
  const desired = new Map<AgentId, Record<string, unknown>>();
  for (const ref of manifest.mcp) {
    const name = mcpRefName(ref);
    const { def } = requireDef(defs, name);
    const hash = hashMcpDef(def);
    const old = files.lock.mcp[name];
    lockOut.mcp[name] = old && old.hash === hash && old.contextTokens !== undefined ? { hash, contextTokens: old.contextTokens } : { hash };
    for (const agent of mcpRefAgents(ref, manifest)) {
      const table = desired.get(agent) ?? {};
      table[name] = ADAPTERS[agent].renderMcp(def);
      desired.set(agent, table);
    }
  }
  for (const agent of ALL_AGENTS) {
    const adapter = ADAPTERS[agent];
    const managedOld = files.lock.managed[agent]?.mcp ?? [];
    const want = desired.get(agent) ?? {};
    if (!managedOld.length && !Object.keys(want).length) continue;
    const file = path.join(dir, adapter.mcpFile);
    const before = await readText(file);
    const { after, managed } = mergeIntoFile({
      before,
      format: adapter.format,
      key: adapter.serversKey,
      desired: want,
      managedOld,
      adopt: opts.adopt ?? false,
      file: adapter.mcpFile,
      retryCommand: input.retryCommand,
    });
    p.write(file, before, after, agent);
    const entry = lockOut.managed[agent] ?? { mcp: [], plugins: [] };
    entry.mcp = managed;
    lockOut.managed[agent] = entry;
  }
}

async function planPlugins(p: Planner, input: ProjectPlanInput, lockOut: LockFile): Promise<void> {
  const { dir, manifest, files, opts } = input;
  const adapter = ADAPTERS['claude-code'];
  const cfgPlugins = adapter.plugins!;
  const enabled = manifest.agents.includes('claude-code');
  if (!enabled && manifest.plugins.length) p.warn('plugins only take effect for claude-code, which is not in this project\'s agents');
  const want: Record<string, unknown> = {};
  if (enabled) for (const name of manifest.plugins) want[name] = true;
  const managedOld = files.lock.managed['claude-code']?.plugins ?? [];
  if (!managedOld.length && !Object.keys(want).length) return;
  const file = path.join(dir, cfgPlugins.file);
  const before = await readText(file);
  const { after, managed } = mergeIntoFile({
    before,
    format: 'json',
    key: cfgPlugins.key,
    desired: want,
    managedOld,
    adopt: opts.adopt ?? false,
    file: cfgPlugins.file,
    retryCommand: input.retryCommand,
  });
  p.write(file, before, after, 'claude-code');
  const entry = lockOut.managed['claude-code'] ?? { mcp: [], plugins: [] };
  entry.plugins = managed;
  lockOut.managed['claude-code'] = entry;
}

export function gitignoreLines(agents: AgentId[]): string[] {
  const lines = ['.agents/skills/'];
  for (const a of agents) {
    const entry = ADAPTERS[a].skillEntry;
    if (entry) lines.push(entry);
  }
  return lines;
}

export async function planGitignore(p: Planner, dir: string, agents: AgentId[]): Promise<void> {
  const file = path.join(dir, '.gitignore');
  const before = await readText(file);
  const have = new Set((before ?? '').split(/\r?\n/).map((l) => l.trim()));
  const missing = gitignoreLines(agents).filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, '')) && !have.has(`/${l}`));
  if (!missing.length) return;
  let after = before ?? '';
  if (after && !after.endsWith('\n')) after += '\n';
  if (after) after += '\n';
  after += '# atm (agent tool manager): symlinks are machine-specific\n' + missing.join('\n') + '\n';
  p.write(file, before, after);
}

/**
 * 规划整个项目：Skill 软链 → 入口软链 → 各 Agent MCP → 插件 → .gitignore → 清单 → lock。
 * 返回新的 lock（未写盘）。
 */
export async function planProject(p: Planner, input: ProjectPlanInput): Promise<LockFile> {
  const lockOut: LockFile = emptyLock();
  await planSkills(p, input, lockOut);
  await planEntryLinks(p, input);
  if (input.skillsOnly) {
    lockOut.mcp = input.files.lock.mcp;
    lockOut.managed = input.files.lock.managed;
  } else {
    await planMcp(p, input, lockOut);
    await planPlugins(p, input, lockOut);
  }
  if (input.gitignore) await planGitignore(p, input.dir, input.manifest.agents);
  await planManifestAndLock(p, input.dir, input.files, input.manifest, lockOut);
  return lockOut;
}

export async function planManifestAndLock(p: Planner, dir: string, files: ProjectFiles, manifest: ToolsManifest, lock: LockFile): Promise<void> {
  const nextManifest = serializeManifest(manifest);
  if (!files.manifest || serializeManifest(files.manifest) !== nextManifest) {
    p.write(paths.manifest(dir), files.manifestText, nextManifest);
  }
  const nextLock = serializeLock(lock);
  if (files.lockText === null || serializeLock(files.lock) !== nextLock) {
    p.write(paths.lock(dir), files.lockText, nextLock);
  }
}
