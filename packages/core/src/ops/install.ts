import path from 'node:path';
import type { InstallOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { requireManifest } from '../manifest.js';
import { loadPluginIndex } from '../plugins/index.js';
import { contextFor } from './inspect.js';
import { planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';

/** 按清单全量还原：克隆缺失仓库 → 建全部软链 → 全量渲染 MCP 与插件 → 比对 lock。幂等。 */
export async function installProject(ctx: Ctx, dir: string, opts: InstallOptions = {}): Promise<WriteResult> {
  const abs = path.resolve(dir);
  const command = withFlags(`atm install${opts.strict ? ' --strict' : ''}`, opts);
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command,
    activity: { message: 'Installed tools from manifest' },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      const plugins = await loadPluginIndex(ctx);
      for (const name of files.manifest.plugins) {
        if (!plugins.installed.has(name)) planner.warn(`plugin ${name} is not installed; run /plugin install ${name}`);
      }
      const lock = await planProject(planner, {
        cfg,
        dir: abs,
        files,
        manifest: files.manifest,
        opts,
        resolver,
        resolveAll: true,
        gitignore: true,
        retryCommand: 'atm install',
      });
      return { contextAfter: await contextFor(ctx, files.manifest, lock, plugins) };
    },
  });
}

/** 只重建 Skill 软链（fix 用）。 */
export async function installSkillLinks(ctx: Ctx, dir: string, opts: InstallOptions = {}): Promise<WriteResult> {
  const abs = path.resolve(dir);
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: 'atm install',
    activity: { message: 'Rebuilt skill links', kind: 'skill' },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      await planProject(planner, {
        cfg,
        dir: abs,
        files,
        manifest: files.manifest,
        opts,
        resolver,
        skillsOnly: true,
        resolveAll: true,
        retryCommand: 'atm install',
      });
    },
  });
}
