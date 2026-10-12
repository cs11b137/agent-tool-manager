import path from 'node:path';
import type { WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { linkState } from '../fs/symlink.js';
import { isDir, listDir } from '../fs/walk.js';
import { emptyManifest, paths, readProjectFiles } from '../manifest.js';
import { ENTRY_TARGET, planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';
import type { Planner } from './planner.js';

/** `.claude/skills` 是实体目录时：内容迁移到 `.agents/skills/`，再改成软链。 */
async function planMigration(p: Planner, dir: string, opts: WriteOptions): Promise<boolean> {
  const entry = path.join(dir, '.claude', 'skills');
  const st = await linkState(entry);
  if (st.kind !== 'dir') return false;
  const skillsDir = paths.skillsDir(dir);
  const children = (await listDir(entry)).filter((c) => c !== '.DS_Store');
  const conflicts: string[] = [];
  const replace: Array<{ name: string; target: string }> = [];
  for (const child of children) {
    const dest = await linkState(path.join(skillsDir, child));
    if (dest.kind === 'missing') continue;
    if (opts.force && dest.kind === 'symlink') replace.push({ name: child, target: dest.target });
    else conflicts.push(child);
  }
  if (conflicts.length) {
    throw new AtmError('CONFLICT', `cannot migrate .claude/skills: ${conflicts.join(', ')} already exist in .agents/skills`, {
      candidates: conflicts,
      nextCommand: 'resolve the duplicates by hand (or atm init --force to replace symlinks), then atm init',
    });
  }
  if (!(await isDir(skillsDir))) p.mkdir(skillsDir);
  for (const r of replace) p.unlink(path.join(skillsDir, r.name), r.target);
  for (const child of await listDir(entry)) p.move(path.join(entry, child), path.join(skillsDir, child));
  p.rmdir(entry);
  p.symlink(entry, null, ENTRY_TARGET, 'claude-code');
  return true;
}

export async function initProject(ctx: Ctx, dir: string, opts: WriteOptions = {}): Promise<WriteResult> {
  const abs = path.resolve(dir);
  if (!(await isDir(abs))) {
    throw new AtmError('NOT_FOUND', `directory not found: ${abs}`, { nextCommand: `mkdir -p ${abs} && atm init` });
  }
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: withFlags('atm init', opts),
    activity: { message: 'Initialized project' },
    async plan({ cfg, planner, resolver }) {
      const files = await readProjectFiles(abs);
      if (files.manifest) planner.warn('project is already initialized; ensured links and .gitignore');
      const manifest = files.manifest ?? emptyManifest(cfg.defaultAgents);
      const migrated = manifest.agents.includes('claude-code') ? await planMigration(planner, abs, opts) : false;
      await planProject(planner, {
        cfg,
        dir: abs,
        files,
        manifest,
        opts,
        resolver,
        gitignore: true,
        retryCommand: 'atm init',
        ...(migrated ? { skipEntries: new Set(['.claude/skills']) } : {}),
      });
    },
  });
}
