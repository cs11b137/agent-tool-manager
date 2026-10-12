import path from 'node:path';
import type { WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { linkState } from '../fs/symlink.js';
import { exists } from '../fs/walk.js';
import { git } from '../git.js';
import { paths, relativeWorktree, requireManifest } from '../manifest.js';
import { contextFor } from './inspect.js';
import { planManifestAndLock } from './project.js';
import { executeWrite, withFlags } from './write.js';

export function worktreeDir(root: string, repoName: string, rev: string): string {
  return path.join(root, '.worktrees', `${repoName}@${rev.replace(/[^A-Za-z0-9._-]/g, '-')}`);
}

/** `atm pin <skill> <rev>`：建 `<root>/.worktrees/<repo>@<rev>` worktree，软链改指向它。 */
export async function pinSkill(ctx: Ctx, dir: string, skillName: string, rev: string, opts: WriteOptions = {}): Promise<WriteResult> {
  const abs = path.resolve(dir);
  const command = `atm pin ${skillName} ${rev}`;
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: withFlags(command, opts),
    activity: { message: `Pinned skill ${skillName} to ${rev}`, kind: 'skill' },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      const ref = files.manifest.skills.find((s) => s.name === skillName);
      if (!ref) {
        throw new AtmError('NOT_FOUND', `skill ${skillName} is not in .agents/tools.json`, {
          candidates: files.manifest.skills.map((s) => s.name),
          nextCommand: 'atm list',
        });
      }
      const co = await resolver.checkout(ref.repo);
      let commit: string;
      try {
        commit = await git.revParse(co.scanDir, rev, ctx.signal);
      } catch {
        throw new AtmError('NOT_FOUND', `rev ${rev} not found in ${ref.repo}`, { nextCommand: `git -C ${co.dir} fetch` });
      }
      const old = files.lock.skills[skillName];
      const resolved = old && old.repo === ref.repo ? null : await resolver.resolve(ref);
      const relPath = old && old.repo === ref.repo ? old.path : resolved!.locked.path;
      const tokens = old && old.repo === ref.repo ? old.contextTokens : resolved!.locked.contextTokens;
      const wt = worktreeDir(cfg.root, path.basename(co.dir), rev);
      if (!(await exists(wt))) {
        planner.exec(
          wt,
          `git worktree add --detach ${planner.rel(wt)} ${rev}`,
          async () => {
            await git.worktreeAdd(co.dir, wt, rev, ctx.signal);
          },
          async () => {
            await git.worktreeRemove(co.dir, wt).catch(() => undefined);
          },
        );
      }
      const linkPath = path.join(paths.skillsDir(abs), skillName);
      const st = await linkState(linkPath);
      if (st.kind === 'dir' || st.kind === 'file') {
        throw new AtmError('CONFLICT', `.agents/skills/${skillName} is not a symlink`, { nextCommand: `move .agents/skills/${skillName} away` });
      }
      planner.symlink(linkPath, st.kind === 'symlink' ? st.target : null, path.join(wt, relPath));
      const manifest = { ...files.manifest, skills: files.manifest.skills.map((s) => (s.name === skillName ? { ...s, rev } : s)) };
      const lock = { ...files.lock, skills: { ...files.lock.skills } };
      // lock 会被提交：worktree 存相对 <root> 的路径（`.worktrees/<repo>@<rev>`），不存本机绝对路径
      lock.skills[skillName] = { repo: ref.repo, path: relPath, commit, rev, contextTokens: tokens, worktree: relativeWorktree(cfg.root, wt) };
      await planManifestAndLock(planner, abs, files, manifest, lock);
      return { contextAfter: await contextFor(ctx, manifest, lock) };
    },
  });
}
