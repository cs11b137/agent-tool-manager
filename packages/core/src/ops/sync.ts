import path from 'node:path';
import type { SyncResult, WriteOptions } from '../types.js';
import { projectId, type Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { applyOps } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { exists, isDir } from '../fs/walk.js';
import { git } from '../git.js';
import { paths, readProjectFiles, serializeLock } from '../manifest.js';
import { discoverSkills } from '../skills/discover.js';
import { parseRepo } from '../skills/repo.js';
import { locateRepo, locateRepoDir, pickSkill } from '../skills/resolver.js';
import { Planner } from './planner.js';
import { planSkillLink } from './project.js';
import { notifyWrite } from './write.js';

type RepoRow = SyncResult['repos'][number];

/** 对涉及的仓库 `git pull --ff-only`；dirty 跳过；更新引用该仓库的所有已注册项目的 lock（Skill 在仓库内移动时同时改软链）。 */
export async function syncRepos(ctx: Ctx, repos?: string[], opts: WriteOptions = {}): Promise<SyncResult> {
  const cfg = await loadConfig(ctx);
  const rows: RepoRow[] = [];
  // 仓库目录被别的仓库占用：不碰它，直接记为 failed
  const unlocatable = new Map<string, RepoRow>(); // spec -> row
  const noteUnlocatable = (spec: string, dir: string | null, reason: string | undefined) => {
    if (unlocatable.has(spec)) return;
    unlocatable.set(spec, { repo: spec, dir: dir ?? '', status: 'failed', message: `${reason ?? 'cannot locate repository'}; skipped` });
  };

  // 收集已注册项目引用的仓库
  const projectRepos = new Map<string, Set<string>>(); // repoDir -> specs
  const projects: Array<{ dir: string }> = [];
  for (const dir of cfg.projects) {
    if (!(await isDir(dir))) continue;
    const files = await readProjectFiles(dir).catch(() => null);
    if (!files?.manifest) continue;
    projects.push({ dir });
    for (const s of files.manifest.skills) {
      const loc = await locateRepo(ctx, cfg.root, s.repo);
      if (!loc.dir) {
        noteUnlocatable(s.repo, loc.expected, loc.reason);
        continue;
      }
      const set = projectRepos.get(loc.dir) ?? new Set<string>();
      set.add(s.repo);
      projectRepos.set(loc.dir, set);
    }
  }
  const targets = new Map<string, string>(); // repoDir -> spec
  if (repos?.length) {
    for (const r of repos) {
      const asDir = path.join(cfg.root, r);
      if (!r.includes('/') && (await isDir(asDir))) {
        targets.set(asDir, r);
        continue;
      }
      const loc = await locateRepo(ctx, cfg.root, r);
      if (loc.dir) targets.set(loc.dir, r);
      else rows.push({ repo: r, dir: loc.expected ?? '', status: 'failed', message: `${loc.reason ?? 'cannot locate repository'}; skipped` });
    }
  } else {
    for (const [dir, specs] of projectRepos) targets.set(dir, [...specs][0]!);
    rows.push(...unlocatable.values());
  }

  const changed = new Set<string>();
  for (const [dir, spec] of targets) {
    const row: RepoRow = { repo: spec, dir, status: 'up-to-date' };
    try {
      if (!(await exists(dir))) {
        if (opts.dryRun) {
          row.status = 'cloned';
          row.message = 'would clone';
        } else {
          await git.clone(parseRepo(spec, ctx.home).url, dir, ctx.signal);
          row.status = 'cloned';
          row.to = await git.head(dir, ctx.signal);
          changed.add(dir);
        }
      } else if (await git.isDirty(dir, ctx.signal)) {
        row.status = 'skipped-dirty';
        row.message = 'local changes — commit or stash them (consider a PR upstream), then atm sync';
      } else {
        const from = await git.head(dir, ctx.signal);
        row.from = from;
        if (opts.dryRun) {
          await git.fetch(dir, ctx.signal);
          const b = await git.behind(dir, ctx.signal);
          if (b.count > 0 && b.upstream) {
            row.status = 'updated';
            row.to = b.upstream;
          }
        } else {
          await git.pullFfOnly(dir, ctx.signal);
          const to = await git.head(dir, ctx.signal);
          row.to = to;
          if (to !== from) {
            row.status = 'updated';
            changed.add(dir);
          }
        }
      }
    } catch (e) {
      const msg = errorMessage(e);
      row.status = /fast-forward|diverg/i.test(msg) ? 'skipped-diverged' : 'failed';
      row.message = msg;
    }
    rows.push(row);
  }

  const updatedProjects: string[] = [];
  if (!opts.dryRun && changed.size) {
    ctx.emit({ type: 'library.changed' });
    for (const { dir } of projects) {
      const planner = await withLock(paths.writeLock(dir), async () => {
        const files = await readProjectFiles(dir);
        if (!files.manifest) return null;
        const p = new Planner(ctx, dir);
        const lock = { ...files.lock, skills: { ...files.lock.skills } };
        let touched = false;
        for (const s of files.manifest.skills) {
          const locked = lock.skills[s.name];
          if (!locked || locked.worktree) continue;
          const repoDir = await locateRepoDir(ctx, cfg.root, s.repo);
          if (!repoDir || !changed.has(repoDir)) continue;
          const head = await git.head(repoDir, ctx.signal);
          if (head === locked.commit) continue;
          touched = true;
          try {
            const skill = pickSkill(await discoverSkills(ctx, repoDir, path.basename(repoDir)), s);
            lock.skills[s.name] = { ...locked, path: skill.path, commit: head, contextTokens: skill.contextTokens };
            if (skill.path !== locked.path) {
              // 上游移动了 Skill：软链跟着改指向（与 install 同一套软链规划）
              try {
                await planSkillLink(p, dir, s.name, path.join(repoDir, skill.path));
              } catch (e) {
                p.warn(`${s.name}: ${errorMessage(e)}`);
              }
            }
          } catch {
            lock.skills[s.name] = { ...locked, commit: head };
          }
        }
        if (!touched) return null;
        p.write(paths.lock(dir), files.lockText, serializeLock(lock));
        if (!p.ops.length) return null;
        await applyOps(p.ops);
        return p;
      });
      if (planner) {
        updatedProjects.push(projectId(dir));
        notifyWrite(ctx, dir, { applied: true, files: planner.files(), warnings: [...planner.warnings] }, { message: 'Updated lock after sync', kind: 'skill' });
      }
    }
  }
  return { repos: rows, updatedProjects };
}
