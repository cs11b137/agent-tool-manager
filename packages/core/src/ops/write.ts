import fs from 'node:fs/promises';
import path from 'node:path';
import type { ContextBreakdown, GlobalConfig, ToolKind, WriteOptions, WriteResult } from '../types.js';
import { projectId, type Ctx } from '../context.js';
import { addProjectToRegistry, loadConfig } from '../config.js';
import { applyOps } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { paths } from '../manifest.js';
import { SkillResolver } from '../skills/resolver.js';
import { Planner } from './planner.js';

export interface PlanContext {
  ctx: Ctx;
  cfg: GlobalConfig;
  dir: string;
  planner: Planner;
  resolver: SkillResolver;
  dryRun: boolean;
}

export interface PlanOutcome {
  contextAfter?: ContextBreakdown;
}

export interface WriteSpec {
  dir: string;
  opts?: WriteOptions;
  /** 等价的 CLI 命令 */
  command: string;
  activity: { message: string; kind?: ToolKind };
  plan(pc: PlanContext): Promise<PlanOutcome | void>;
}

export function withFlags(command: string, opts: WriteOptions = {}): string {
  const flags = [opts.adopt ? '--adopt' : '', opts.force ? '--force' : ''].filter(Boolean);
  return [command, ...flags].join(' ');
}

/**
 * 写操作统一流程：plan() → dryRun ? 返回 : (持锁 → 重新 plan → apply → 释放锁 → 事件)。
 * 非 dryRun 时 plan 在锁内执行，保证 plan 基于最新磁盘状态。
 */
export async function executeWrite(ctx: Ctx, spec: WriteSpec): Promise<WriteResult> {
  const dryRun = spec.opts?.dryRun ?? false;
  const dir = path.resolve(spec.dir);
  const cfg = await loadConfig(ctx);

  const runPlan = async () => {
    const planner = new Planner(ctx, dir);
    const resolver = new SkillResolver(ctx, cfg.root, dryRun ? 'temp' : 'final');
    try {
      const outcome = (await spec.plan({ ctx, cfg, dir, planner, resolver, dryRun })) ?? {};
      const clones = await resolver.clonedRepos();
      for (const co of clones.reverse()) {
        planner.ops.unshift({
          change: {
            path: co.dir,
            relPath: planner.rel(co.dir),
            type: 'dir',
            before: null,
            after: null,
            diff: `git clone ${co.repo.url} ${planner.rel(co.dir)}\n`,
            additions: 0,
            deletions: 0,
          },
          action: 'none',
        });
      }
      return { planner, outcome };
    } finally {
      await resolver.dispose();
    }
  };

  const result = (planner: Planner, outcome: PlanOutcome, applied: boolean): WriteResult => {
    const r: WriteResult = { applied, files: planner.files(), warnings: [...planner.warnings], command: spec.command };
    if (outcome.contextAfter) r.contextAfter = outcome.contextAfter;
    return r;
  };

  if (dryRun) {
    const { planner, outcome } = await runPlan();
    return result(planner, outcome, false);
  }

  await fs.mkdir(paths.agentsDir(dir), { recursive: true });
  const { planner, outcome } = await withLock(paths.writeLock(dir), async () => {
    const planned = await runPlan();
    await applyOps(planned.planner.ops);
    return planned;
  });
  await addProjectToRegistry(ctx, dir);
  const res = result(planner, outcome, true);
  notifyWrite(ctx, dir, res, spec.activity);
  return res;
}

export function notifyWrite(ctx: Ctx, dir: string, res: WriteResult, activity: { message: string; kind?: ToolKind }): void {
  const pid = projectId(dir);
  const entry: Parameters<Ctx['activity']>[0] = {
    level: res.warnings.length ? 'warn' : 'info',
    projectId: pid,
    projectName: path.basename(dir),
    message: activity.message,
  };
  if (activity.kind) entry.kind = activity.kind;
  ctx.activity(entry);
  if (res.files.length) {
    const touchesManifest = res.files.some((f) => f.path === paths.manifest(dir) || f.path === paths.lock(dir));
    ctx.emit({ type: 'project.changed', projectId: pid, reason: touchesManifest ? 'manifest' : 'agent-config' });
  }
}
