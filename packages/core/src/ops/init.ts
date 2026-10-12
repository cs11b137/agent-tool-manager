import path from 'node:path';
import type { WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { linkState } from '../fs/symlink.js';
import { isDir, listDir, readText } from '../fs/walk.js';
import { emptyManifest, paths, readProjectFiles } from '../manifest.js';
import { ENTRY_TARGET, planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';
import type { Planner } from './planner.js';

interface Migration {
  migrated: boolean;
  /** 迁移过来的实体（非软链）目录 / 文件名：它们是提交过的内容，不能被 gitignore */
  realNames: string[];
}

/** `.claude/skills` 是实体目录时：内容迁移到 `.agents/skills/`，再改成软链。 */
async function planMigration(p: Planner, dir: string, opts: WriteOptions): Promise<Migration> {
  const entry = path.join(dir, '.claude', 'skills');
  const st = await linkState(entry);
  if (st.kind !== 'dir') return { migrated: false, realNames: [] };
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
  const realNames: string[] = [];
  for (const child of await listDir(entry)) {
    const cs = await linkState(path.join(entry, child));
    if ((cs.kind === 'dir' || cs.kind === 'file') && child !== '.DS_Store') realNames.push(child);
    p.move(path.join(entry, child), path.join(skillsDir, child));
  }
  p.rmdir(entry);
  p.symlink(entry, null, ENTRY_TARGET, 'claude-code');
  return { migrated: true, realNames };
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
      const migration = manifest.agents.includes('claude-code') ? await planMigration(planner, abs, opts) : { migrated: false, realNames: [] };
      const migrated = migration.migrated;
      if (migration.realNames.length) {
        planner.warn(
          `moved ${migration.realNames.join(', ')} from .claude/skills into .agents/skills; .agents/skills/ is NOT gitignored so these stay tracked — ` +
            'commit the move (git add -A .claude/skills .agents/skills); only atm-managed skill symlinks are ignored one by one',
        );
        const gi = (await readText(path.join(abs, '.gitignore'))) ?? '';
        if (gi.split(/\r?\n/).some((l) => ['.agents/skills/', '.agents/skills', '/.agents/skills/', '/.agents/skills'].includes(l.trim()))) {
          planner.warn('.gitignore already ignores .agents/skills/ entirely; remove that line so the migrated skills stay tracked');
        }
      }
      await planProject(planner, {
        cfg,
        dir: abs,
        files,
        manifest,
        opts,
        resolver,
        gitignore: true,
        migratedRealDirs: migration.realNames.length > 0,
        retryCommand: 'atm init',
        ...(migrated ? { skipEntries: new Set(['.claude/skills']) } : {}),
      });
    },
  });
}
