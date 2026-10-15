import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LockedSkill, SkillRef } from '../types.js';
import { checkAbort, displayPath, type Ctx } from '../context.js';
import { AtmError, errorMessage } from '../errors.js';
import { exists } from '../fs/walk.js';
import { git } from '../git.js';
import { isToolName, NAME_RULE } from '../manifest.js';
import { discoverSkills, scanSkills, type DiscoveredSkill } from './discover.js';
import { SHARED_REPO } from '../ops/shared-repository.js';
import { normalizeRemote, parseRepo, type RepoSpec } from './repo.js';

export type CloneMode = 'final' | 'temp' | 'never';

export interface RepoCheckout {
  repo: RepoSpec;
  /** 最终目录 `<root>/<name>` */
  dir: string;
  /** 实际读取的目录（dryRun 时为临时克隆） */
  scanDir: string;
  /** 本次操作是否（将要）克隆 */
  cloned: boolean;
  head: string;
}

export interface ResolvedSkill {
  locked: LockedSkill;
  checkout: RepoCheckout;
  skill: DiscoveredSkill;
  warnings: string[];
}

async function realOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function sameRemote(home: string, a: string, b: string): Promise<boolean> {
  const na = normalizeRemote(a, home);
  const nb = normalizeRemote(b, home);
  if (na === nb) return true;
  if (na.startsWith('/') && nb.startsWith('/')) {
    const ra = await realOrResolve(na);
    const rb = await realOrResolve(nb);
    return ra.replace(/\.git$/, '') === rb.replace(/\.git$/, '');
  }
  return false;
}

/** 仓库在 `<root>` 下的候选目录：`<name>`，有 owner 时再加 `<owner>-<name>`。 */
export function repoDirCandidates(root: string, repo: RepoSpec): string[] {
  const dirs = [path.join(root, repo.name)];
  if (repo.owner) dirs.push(path.join(root, `${repo.owner}-${repo.name}`));
  return dirs;
}

export interface RepoLocation {
  /** 仓库所在目录；被别的仓库占用 / 无法解析时为 null */
  dir: string | null;
  /** 期望的目录（`<root>/<name>`），无法解析时为 null */
  expected: string | null;
  /** dir 为 null 时的原因 */
  reason?: string;
}

/**
 * 判断已存在的目录是否就是请求的仓库：本地路径指向它自身，或 origin remote 与请求一致。
 * 没有 origin remote 的目录不算匹配（视为被占用）。
 */
async function matchesRepo(ctx: Ctx, repo: RepoSpec, dir: string): Promise<{ ok: boolean; remote: string | null }> {
  if (await isSelf(repo, dir)) return { ok: true, remote: null };
  const remote = await git.isRepoRoot(dir, ctx.signal) ? await git.remoteUrl(dir, ctx.signal) : null;
  return { ok: Boolean(remote) && (await sameRemote(ctx.home, remote!, repo.url)), remote };
}

function occupiedReason(ctx: Ctx, dir: string, remote: string | null): string {
  const shown = displayPath(ctx.home, null, dir);
  return remote ? `${shown} is already used by another repository (origin ${remote})` : `${shown} exists but has no origin remote, so it cannot be verified as this repository`;
}

/** 不克隆、不报错地找出仓库所在目录（用于 list / doctor / sync 等只读场景）。 */
export async function locateRepo(ctx: Ctx, root: string, spec: string): Promise<RepoLocation> {
  if (spec === SHARED_REPO) return { dir: root, expected: root };
  let repo: RepoSpec;
  try {
    repo = parseRepo(spec, ctx.home);
  } catch (e) {
    return { dir: null, expected: null, reason: errorMessage(e) };
  }
  const cands = repoDirCandidates(root, repo);
  let firstOccupied: { dir: string; remote: string | null } | null = null;
  for (const d of cands) {
    if (!(await exists(d))) continue;
    const m = await matchesRepo(ctx, repo, d);
    if (m.ok) return { dir: d, expected: cands[0]! };
    firstOccupied ??= { dir: d, remote: m.remote };
  }
  // 首选目录空着：仓库应该（将会）克隆在那里
  if (!(await exists(cands[0]!))) return { dir: cands[0]!, expected: cands[0]! };
  return { dir: null, expected: cands[0]!, reason: occupiedReason(ctx, firstOccupied!.dir, firstOccupied!.remote) };
}

export async function locateRepoDir(ctx: Ctx, root: string, spec: string): Promise<string | null> {
  return (await locateRepo(ctx, root, spec)).dir;
}

async function isSelf(repo: RepoSpec, dir: string): Promise<boolean> {
  if (!repo.url.startsWith('/') && !repo.url.startsWith('file://')) return false;
  const p = repo.url.startsWith('file://') ? decodeURIComponent(repo.url.slice(7)) : repo.url;
  return (await realOrResolve(p)) === (await realOrResolve(dir));
}

/**
 * Skill 解析器（每个写操作一个实例，按仓库缓存 checkout）。
 * clone 模式：final 直接克隆到 `<root>`；temp 克隆到临时目录（dryRun）；never 缺仓库即报错。
 */
export class SkillResolver {
  private readonly checkouts = new Map<string, Promise<RepoCheckout>>();
  private readonly temps: string[] = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly root: string,
    private readonly mode: CloneMode,
  ) {}

  checkout(spec: string): Promise<RepoCheckout> {
    let p = this.checkouts.get(spec);
    if (!p) {
      p = this.doCheckout(spec);
      this.checkouts.set(spec, p);
    }
    return p;
  }

  /** 本次操作新克隆（或 dryRun 将要克隆）的仓库。 */
  async clonedRepos(): Promise<RepoCheckout[]> {
    const all = await Promise.allSettled([...this.checkouts.values()]);
    return all.flatMap((r) => (r.status === 'fulfilled' && r.value.cloned ? [r.value] : []));
  }

  private async doCheckout(spec: string): Promise<RepoCheckout> {
    const { ctx } = this;
    if (spec === SHARED_REPO) {
      if (!(await git.isRepoRoot(this.root))) throw new AtmError('NOT_INITIALIZED', '请先创建共享仓库');
      return { repo: { spec, url: this.root, name: 'shared' }, dir: this.root, scanDir: this.root, cloned: false, head: await git.tryHead(this.root) ?? '' };
    }
    const repo = parseRepo(spec, ctx.home);
    const cands = repoDirCandidates(this.root, repo);
    let occupied: { dir: string; remote: string | null } | null = null;
    for (const d of cands) {
      if (!(await exists(d))) continue;
      const m = await matchesRepo(ctx, repo, d);
      if (m.ok) return { repo, dir: d, scanDir: d, cloned: false, head: (await git.tryHead(d, ctx.signal)) ?? '' };
      occupied ??= { dir: d, remote: m.remote };
    }
    const target = cands[0]!;
    if (await exists(target)) {
      const alt = repo.owner ? path.join(this.root, `${repo.owner}-${repo.name}`) : `${target}-2`;
      throw new AtmError('CONFLICT', occupiedReason(ctx, target, occupied?.dir === target ? occupied.remote : await git.remoteUrl(target, ctx.signal)), {
        nextCommand: `git clone ${repo.url} ${displayPath(ctx.home, null, alt)}`,
      });
    }
    checkAbort(ctx);
    if (this.mode === 'never') {
      throw new AtmError('NOT_FOUND', `repository ${spec} is not cloned at ${displayPath(ctx.home, null, target)}`, {
        nextCommand: 'atm install',
      });
    }
    if (this.mode === 'temp') {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-dry-'));
      this.temps.push(tmp);
      const scanDir = path.join(tmp, repo.name);
      await git.clone(repo.url, scanDir, ctx.signal);
      return { repo, dir: target, scanDir, cloned: true, head: (await git.tryHead(scanDir, ctx.signal)) ?? '' };
    }
    await fs.mkdir(this.root, { recursive: true });
    await git.clone(repo.url, target, ctx.signal);
    ctx.emit({ type: 'library.changed' });
    return { repo, dir: target, scanDir: target, cloned: true, head: (await git.tryHead(target, ctx.signal)) ?? '' };
  }

  async listSkills(co: RepoCheckout): Promise<DiscoveredSkill[]> {
    if (co.repo.spec === SHARED_REPO) return (await scanSkills(path.join(co.scanDir, 'skills'))).map((s) => ({ ...s, path: path.join('skills', s.path) }));
    // dryRun（temp 模式）不写缓存
    return this.mode !== 'temp' && co.scanDir === co.dir ? discoverSkills(this.ctx, co.dir, path.basename(co.dir)) : scanSkills(co.scanDir);
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill> {
    const co = await this.checkout(ref.repo);
    const skills = await this.listSkills(co);
    const skill = pickSkill(skills, ref);
    const warnings: string[] = [];
    if (ref.rev) {
      try {
        const revCommit = await git.revParse(co.scanDir, ref.rev, this.ctx.signal);
        if (revCommit !== co.head) {
          warnings.push(`shared repo ${ref.repo} is at ${co.head.slice(0, 7)}, manifest asks for ${ref.rev}; run \`atm pin ${ref.name} ${ref.rev}\` to isolate`);
        }
      } catch {
        warnings.push(`rev ${ref.rev} not found in ${ref.repo}`);
      }
    }
    const locked: LockedSkill = { repo: ref.repo, path: skill.path, commit: co.head, contextTokens: skill.contextTokens };
    if (ref.rev) locked.rev = ref.rev;
    return { locked, checkout: co, skill, warnings };
  }

  async dispose(): Promise<void> {
    for (const t of this.temps) await fs.rm(t, { recursive: true, force: true });
  }
}

/** 按 frontmatter name 匹配；没有则兜底目录名。0 个 / 多个都报错并给出候选。 */
export function pickSkill(skills: DiscoveredSkill[], ref: SkillRef): DiscoveredSkill {
  if (!isToolName(ref.name)) {
    // 名字会成为 `.agents/skills/<name>`：frontmatter 里带空格、斜杠等的名字不能直接用，建议目录名
    const dirs = [...new Set(skills.filter((s) => s.name === ref.name).map((s) => path.basename(s.path)).filter(isToolName))].sort();
    throw new AtmError('NOT_FOUND', `skill name ${JSON.stringify(ref.name)} is not a valid name (${NAME_RULE})${dirs.length ? `; use the directory name ${dirs.join(' / ')}` : ''}`, {
      candidates: dirs,
      nextCommand: dirs.length ? `atm add skill ${ref.repo} ${dirs[0]}` : `atm search ${ref.name}`,
    });
  }
  const byName = skills.filter((s) => s.declaredName && s.name === ref.name);
  const pool = byName.length ? byName : skills.filter((s) => path.basename(s.path) === ref.name || (!s.declaredName && s.name === ref.name));
  if (pool.length === 1) return pool[0]!;
  if (pool.length > 1) {
    throw new AtmError('AMBIGUOUS', `skill "${ref.name}" matches ${pool.length} directories in ${ref.repo}`, {
      candidates: pool.map((s) => s.path),
      nextCommand: `rename one of the skills in ${ref.repo}`,
    });
  }
  const names = [...new Set(skills.map((s) => s.name))].sort();
  throw new AtmError('NOT_FOUND', `skill "${ref.name}" not found in ${ref.repo}`, {
    candidates: names,
    nextCommand: names.length ? `atm add skill ${ref.repo} ${names[0]}` : `atm search ${ref.name}`,
  });
}
