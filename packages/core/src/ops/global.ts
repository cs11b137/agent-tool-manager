import path from 'node:path';
import type { AddSpec, GlobalReport, MigrateSpec, WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { AtmError } from '../errors.js';
import { applyOps } from '../fs/atomic.js';
import { linkState } from '../fs/symlink.js';
import { readText } from '../fs/walk.js';
import { git } from '../git.js';
import { mergeIntoFile } from '../adapters/merge.js';
import { pluginPaths } from '../plugins/index.js';
import { readSkillMeta } from '../skills/discover.js';
import { repoSlugFromRemote } from '../skills/repo.js';
import { skillTokens } from '../tokens.js';
import { addTool } from './add.js';
import { buildLibrary } from './library.js';
import { loadShared } from './inspect.js';
import { Planner } from './planner.js';

export async function globalReport(ctx: Ctx): Promise<GlobalReport> {
  const cfg = await loadConfig(ctx);
  const shared = await loadShared(ctx, cfg);
  const pp = pluginPaths(ctx);
  const skills: GlobalReport['skills'] = [];
  for (const name of [...shared.globalSkills].sort()) {
    const p = path.join(pp.globalSkills, name);
    const st = await linkState(p);
    const meta = await readSkillMeta(st.kind === 'symlink' ? st.resolved : p);
    if (!meta && st.kind !== 'symlink') continue;
    const skillName = meta?.name ?? name;
    const row: GlobalReport['skills'][number] = {
      name,
      path: p,
      contextTokens: skillTokens(skillName, meta?.description),
      shadowedBy: [...shared.manifests.entries()].filter(([, v]) => v.manifest.skills.some((s) => s.name === name)).map(([id]) => id),
    };
    if (st.kind === 'symlink') row.target = st.resolved;
    skills.push(row);
  }
  const plugins: GlobalReport['plugins'] = [];
  for (const name of [...shared.plugins.globallyEnabled].sort()) {
    plugins.push({
      name,
      installed: shared.plugins.installed.has(name),
      contextTokens: await shared.plugins.contextTokens(name),
      usedBy: [...shared.manifests.entries()].filter(([, v]) => v.manifest.plugins.includes(name)).map(([id]) => id),
    });
  }
  return { skills, plugins };
}

/** 全局 Skill → 可写进清单的 `{ repo, name }`：优先看软链目标所在仓库，否则在工具库中按名字查找。 */
async function globalSkillSpec(ctx: Ctx, name: string): Promise<AddSpec> {
  const cfg = await loadConfig(ctx);
  const st = await linkState(path.join(pluginPaths(ctx).globalSkills, name));
  if (st.kind === 'symlink' && st.resolved.startsWith(cfg.root + path.sep)) {
    const top = st.resolved.slice(cfg.root.length + 1).split(path.sep)[0]!;
    if (top !== '.worktrees') {
      const repoDir = path.join(cfg.root, top);
      const remote = await git.remoteUrl(repoDir, ctx.signal);
      return { kind: 'skill', repo: remote ? repoSlugFromRemote(remote) : repoDir, name };
    }
  }
  const matches = (await buildLibrary(ctx)).filter((i) => i.kind === 'skill' && i.name === name && i.skill);
  if (matches.length === 1) return { kind: 'skill', repo: matches[0]!.skill!.repo, name };
  if (matches.length > 1) {
    throw new AtmError('AMBIGUOUS', `skill ${name} exists in several repositories under ${cfg.root}`, {
      candidates: matches.map((m) => m.skill!.repo),
      nextCommand: `atm add skill <repo> ${name}`,
    });
  }
  throw new AtmError('NOT_FOUND', `cannot find the source repository of global skill ${name} under ${cfg.root}`, {
    nextCommand: `clone its repository into ${cfg.root}, then retry`,
  });
}

/** 迁移向导：对每个项目执行 add，再按需从全局移除。 */
export async function migrateGlobal(
  ctx: Ctx,
  spec: MigrateSpec,
  resolveProject: (idOrDir: string) => Promise<string>,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const add: AddSpec = spec.kind === 'skill' ? await globalSkillSpec(ctx, spec.name) : { kind: 'plugin', name: spec.name };
  const out: WriteResult = { applied: !opts.dryRun, files: [], warnings: [], command: `atm add ${spec.kind} …` };
  for (const id of spec.projectIds) {
    const dir = await resolveProject(id);
    const r = await addTool(ctx, dir, add, opts);
    out.files.push(...r.files);
    out.warnings.push(...r.warnings);
  }
  if (!spec.removeGlobal) return out;

  const p = new Planner(ctx, null);
  const pp = pluginPaths(ctx);
  if (spec.kind === 'skill') {
    const linkPath = path.join(pp.globalSkills, spec.name);
    const st = await linkState(linkPath);
    if (st.kind === 'symlink') p.unlink(linkPath, st.target);
    else if (st.kind !== 'missing') {
      out.warnings.push(`~/.claude/skills/${spec.name} is a real directory; atm does not delete it — remove it by hand`);
    }
  } else {
    const before = await readText(pp.settings);
    const doc = before ? (JSON.parse(before) as { enabledPlugins?: Record<string, unknown> }) : {};
    if (doc.enabledPlugins && Object.hasOwn(doc.enabledPlugins, spec.name)) {
      // 把该条目视为受管，desired 为空 → 删除
      const { after } = mergeIntoFile({ before, format: 'json', key: 'enabledPlugins', desired: {}, managedOld: [spec.name], file: '~/.claude/settings.json' });
      p.write(pp.settings, before, after);
    }
  }
  out.files.push(...p.files());
  out.warnings.push(...p.warnings);
  if (!opts.dryRun && p.ops.length) {
    await applyOps(p.ops);
    ctx.activity({ level: 'info', kind: spec.kind, message: `Removed global ${spec.kind} ${spec.name}` });
    ctx.emit({ type: 'library.changed' });
  }
  return out;
}
