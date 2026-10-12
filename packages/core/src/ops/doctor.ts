import path from 'node:path';
import type { DoctorIssue, DoctorReport, WriteOptions, WriteResult } from '../types.js';
import { projectId, type Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { AtmError, errorMessage } from '../errors.js';
import { isDir } from '../fs/walk.js';
import { mcpRefName, readProjectFiles, requireManifest } from '../manifest.js';
import { hitLevel, scanServer } from '../mcp/secrets.js';
import { countIssues, inspectProject, loadShared, missingProjectIssue, zeroContext } from './inspect.js';
import { installSkillLinks } from './install.js';
import { measureMcp } from './measure.js';

export interface DoctorDeps {
  resolveProject(idOrDir: string): Promise<string>;
}

export async function runDoctor(ctx: Ctx, deps: DoctorDeps, target: string, opts: { measure?: boolean } = {}): Promise<DoctorReport> {
  const cfg = await loadConfig(ctx);
  const all = target === 'all';
  const dirs = all ? cfg.projects : [await deps.resolveProject(target)];
  const measureNotes: string[] = [];
  if (opts.measure) {
    for (const dir of dirs) {
      if (!(await isDir(dir))) continue;
      const files = await readProjectFiles(dir).catch(() => null);
      for (const ref of files?.manifest?.mcp ?? []) {
        const name = mcpRefName(ref);
        try {
          await measureMcp(ctx, dir, name);
        } catch (e) {
          measureNotes.push(`${path.basename(dir)}/${name}: ${errorMessage(e)}`);
        }
      }
    }
  }
  const shared = await loadShared(ctx, cfg);
  const issues: DoctorIssue[] = [];
  const projects: DoctorReport['projects'] = [];
  for (const dir of dirs) {
    if (!(await isDir(dir))) {
      issues.push(missingProjectIssue(dir));
      projects.push({ id: projectId(dir), name: path.basename(dir), context: zeroContext() });
      continue;
    }
    const snap = await inspectProject(ctx, shared, dir);
    projects.push({ id: snap.summary.id, name: snap.summary.name, context: snap.summary.context });
    if (!snap.detail) {
      if (!all) {
        await requireManifest(dir); // 清单无效时抛 INVALID_MANIFEST
        throw new AtmError('NOT_INITIALIZED', `${dir} has no .agents/tools.json`, { nextCommand: 'atm init' });
      }
      continue;
    }
    for (const i of snap.detail.issues) {
      if (i.code === 'context-total' && measureNotes.length) i.detail = `${i.detail ?? ''}; measure failed: ${measureNotes.join('; ')}`;
      issues.push(i);
    }
  }
  if (all) {
    // registry 中所有定义的明文密钥（不论是否被引用）
    for (const r of shared.registry.raw) {
      const name = path.basename(r.file, '.json');
      const level = hitLevel(scanServer(name, r.raw));
      if (level && !issues.some((i) => i.code === 'plaintext-secret' && i.name?.startsWith(`${name}@`))) {
        issues.push({
          id: `plaintext-secret:::mcp:${name}`,
          level,
          code: 'plaintext-secret',
          kind: 'mcp',
          name,
          title: `${level === 'error' ? 'Plaintext secret' : 'Possible secret'} in registry definition ${name}`,
          detail: level === 'error' ? `${r.file} contains a literal secret; use \${VAR} instead` : `${r.file} has a secret-looking value in args/url; use \${VAR} instead`,
          nextCommand: `edit ${r.file}`,
          fixable: false,
        });
      }
    }
  }
  return { checkedAt: new Date().toISOString(), measured: Boolean(opts.measure), counts: countIssues(issues), issues, projects };
}

/** 一键修复：只处理 fixable 的 issue（broken-link / missing-link → 对该项目执行 install 的 Skill 部分）。 */
export async function runFix(ctx: Ctx, deps: DoctorDeps, issueIds: string[], opts: WriteOptions = {}): Promise<WriteResult> {
  const report = await runDoctor(ctx, deps, 'all');
  const projectIds = new Set<string>();
  const warnings: string[] = [];
  for (const id of issueIds) {
    const issue = report.issues.find((i) => i.id === id);
    if (!issue) warnings.push(`issue ${id} not found (already fixed?)`);
    else if (!issue.fixable) warnings.push(`issue ${id} is not auto-fixable: ${issue.nextCommand ?? ''}`.trim());
    else if (issue.projectId) projectIds.add(issue.projectId);
  }
  const out: WriteResult = { applied: !opts.dryRun, files: [], warnings, command: 'atm install' };
  let appliedAny = false;
  for (const pid of projectIds) {
    // 单个项目失败（CONFLICT 等）不影响其他项目：记进 warnings 继续
    try {
      const dir = await deps.resolveProject(pid);
      const r = await installSkillLinks(ctx, dir, opts);
      out.files.push(...r.files);
      out.warnings.push(...r.warnings);
      appliedAny = true;
    } catch (e) {
      const name = report.projects.find((p) => p.id === pid)?.name ?? pid;
      out.warnings.push(`fix ${name} failed: ${errorMessage(e)}${e instanceof AtmError ? ` (next: ${e.nextCommand})` : ''}`);
    }
  }
  if (!appliedAny) out.applied = false;
  return out;
}
