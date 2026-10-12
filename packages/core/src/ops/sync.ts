import path from 'node:path';
import type { SyncResult, WriteOptions } from '../types.js';
import { projectId, type Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { atomicWrite } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { exists, isDir } from '../fs/walk.js';
import { git } from '../git.js';
import { paths, readProjectFiles, serializeLock } from '../manifest.js';
import { discoverSkills } from '../skills/discover.js';
import { parseRepo } from '../skills/repo.js';
import { locateRepoDir, pickSkill } from '../skills/resolver.js';
import { notifyWrite } from './write.js';

type RepoRow = SyncResult['repos'][number];

/** 对涉及的仓库 `git pull --ff-only`；dirty 跳过；更新引用该仓库的所有已注册项目的 lock。 */
export async function syncRepos(ctx: Ctx, repos?: string[], opts: WriteOptions = {}): Promise<SyncResult> {
  const cfg = await loadConfig(ctx);
  // 收集已注册项目引用的仓库
  const projectRepos = new Map<string, Set<string>>(); // repoDir -> specs
  const projects: Array<{ dir: string }> = [];
  for (const dir of cfg.projects) {
    if (!(await isDir(dir))) continue;
    const files = await readProjectFiles(dir).catch(() => null);
    if (!files?.manifest) continue;
    projects.push({ dir });
    for (const s of files.manifest.skills) {
      const repoDir = await locateRepoDir(ctx, cfg.root, s.repo);
      const set = projectRepos.get(repoDir) ?? new Set<string>();
      set.add(s.repo);
      projectRepos.set(repoDir, set);
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
      targets.set(await locateRepoDir(ctx, cfg.root, r), r);
    }
  } else {
    for (const [dir, specs] of projectRepos) targets.set(dir, [...specs][0]!);
  }

  const rows: RepoRow[] = [];
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
      const didUpdate = await withLock(paths.writeLock(dir), async () => {
        const files = await readProjectFiles(dir);
        if (!files.manifest) return false;
        let touched = false;
        for (const s of files.manifest.skills) {
          const locked = files.lock.skills[s.name];
          if (!locked || locked.worktree) continue;
          const repoDir = await locateRepoDir(ctx, cfg.root, s.repo);
          if (!changed.has(repoDir)) continue;
          const head = await git.head(repoDir, ctx.signal);
          if (head === locked.commit) continue;
          try {
            const skill = pickSkill(await discoverSkills(ctx, repoDir, path.basename(repoDir)), s);
            files.lock.skills[s.name] = { ...locked, path: skill.path, commit: head, contextTokens: skill.contextTokens };
          } catch {
            files.lock.skills[s.name] = { ...locked, commit: head };
          }
          touched = true;
        }
        if (!touched) return false;
        await atomicWrite(paths.lock(dir), serializeLock(files.lock));
        return true;
      });
      if (didUpdate) {
        updatedProjects.push(projectId(dir));
        notifyWrite(
          ctx,
          dir,
          { applied: true, files: [{ path: paths.lock(dir), relPath: '.agents/tools.lock.json', type: 'file', before: null, after: null, diff: '', additions: 0, deletions: 0 }], warnings: [] },
          { message: 'Updated lock after sync', kind: 'skill' },
        );
      }
    }
  }
  return { repos: rows, updatedProjects };
}
